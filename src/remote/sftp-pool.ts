/**
 * SFTP connection pool for the remote explorer: one persistent ssh2 client
 * per server id, connected lazily on first use. Operations on one
 * connection are CONCURRENT up to {@link MAX_SFTP_CONCURRENCY} (ssh2
 * multiplexes requests over the sftp channel; the cap keeps a directory
 * explosion from flooding the connection, but parallel directory
 * expansions no longer serialize behind each other's round trips). Idle
 * connections close after remoteIdleTimeoutMs and transparently reconnect
 * on the next operation; a dropped/broken connection is discarded and
 * re-established the same way.
 */
import { readFile } from 'node:fs/promises'
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { Readable } from 'node:stream'
import { SidebarError } from '../wire.ts'
import type { RemoteFsEntry, RemoteFsListing, RemoteFileRead, RemoteServer } from './types.ts'

/** Pool knobs (resolved host config). */
export interface SftpPoolConfig {
  connectTimeoutMs: number
  idleTimeoutMs: number
}

/** Concurrent SFTP operations allowed per server connection. */
export const MAX_SFTP_CONCURRENCY = 4

/** One remote dirent row (structural mirror of ssh2's readdir payload). */
interface RemoteDirent {
  filename: string
  attrs: {
    isDirectory(): boolean
    isSymbolicLink(): boolean
    size: number
    mode: number
  }
}

/** One pooled connection. */
interface PoolEntry {
  serverId: string
  client: Client
  /** Latest sftp session (may be replaced after a reconnect). */
  sftp: SFTPWrapper | null
  /** Resolves the in-flight connect+shell open (serializes first use). */
  connecting: Promise<SFTPWrapper> | null
  /** In-flight operations on this connection (capped by MAX_SFTP_CONCURRENCY). */
  inFlight: number
  /** Operations parked while inFlight is at the cap. */
  waiters: Array<() => void>
  lastUsed: number
  idleTimer: NodeJS.Timeout | null
  broken: boolean
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Map ssh2/fs errors into the sidebar wire error. */
function remoteError(context: string, error: unknown): SidebarError {
  return new SidebarError('remote-error', context + ': ' + messageOf(error), 400)
}

/** Connect config for one server (key bytes read at connect time). */
async function connectConfig(server: RemoteServer, timeoutMs: number): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: timeoutMs,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  }
  if (server.authType === 'password') {
    config.password = server.password
  } else {
    if (server.privateKeyPath === undefined || server.privateKeyPath === '') {
      throw new SidebarError('remote-error', 'server "' + server.name + '" has no private key path', 400)
    }
    let key: string
    try {
      key = await readFile(server.privateKeyPath, 'utf8')
    } catch (error) {
      throw remoteError('cannot read private key "' + server.privateKeyPath + '"', error)
    }
    config.privateKey = key
    if (server.passphrase !== undefined && server.passphrase !== '') config.passphrase = server.passphrase
  }
  return config
}

/** Promise-ify one ssh2 client connect (resolves on ready). */
function connectClient(client: Client, config: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err: Error | undefined): void => {
      if (settled) return
      settled = true
      client.removeListener('ready', onReady)
      client.removeListener('error', onError)
      if (err === undefined) resolve()
      else reject(err)
    }
    const onReady = (): void => { done(undefined) }
    const onError = (err: Error): void => { done(err) }
    client.on('ready', onReady)
    client.on('error', onError)
    client.connect(config)
  })
}

/** Promise-ify client.sftp(). */
function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err !== undefined) reject(err)
      else resolve(sftp)
    })
  })
}

/** One persistent pool. */
export class SftpPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly servers = new Map<string, RemoteServer>()

  constructor(private readonly config: SftpPoolConfig) {}

  /** Refresh the server lookup table (called at mount and after save/delete). */
  syncServers(servers: readonly RemoteServer[]): void {
    this.servers.clear()
    for (const server of servers) this.servers.set(server.id, server)
  }

  /** The full record of one server (undefined when deleted/unknown). */
  getServer(serverId: string): RemoteServer | undefined {
    return this.servers.get(serverId)
  }

  /** Resolve a server record or throw. */
  private requireServer(serverId: string): RemoteServer {
    const server = this.servers.get(serverId)
    if (server === undefined) throw new SidebarError('remote-error', 'unknown server "' + serverId + '"', 404)
    return server
  }

  /** Build a fresh client+entry for one server (lazy, on first use). */
  private createEntry(serverId: string): PoolEntry {
    const server = this.requireServer(serverId)
    const client = new Client()
    const entry: PoolEntry = {
      serverId,
      client,
      sftp: null,
      connecting: null,
      inFlight: 0,
      waiters: [],
      lastUsed: Date.now(),
      idleTimer: null,
      broken: false,
    }
    // A dropped connection invalidates the entry; the next operation
    // discards it and reconnects from scratch.
    client.on('close', () => {
      entry.broken = true
      entry.sftp = null
      entry.connecting = null
    })
    // ssh2 requires an error listener; without one a handshake failure
    // becomes an unhandled 'error' crash. The connect promise already
    // rejects with the same error.
    client.on('error', () => {})
    this.entries.set(serverId, entry)
    return entry
  }

  /** The live entry for a server (reconnecting a broken one transparently). */
  private async ensureEntry(serverId: string): Promise<PoolEntry> {
    this.requireServer(serverId)
    let entry = this.entries.get(serverId)
    if (entry === undefined || entry.broken) {
      entry?.client.end()
      entry = this.createEntry(serverId)
    }
    entry.lastUsed = Date.now()
    return entry
  }

  /** Open (or reopen) the sftp session of one entry. */
  private async sftpOf(entry: PoolEntry): Promise<SFTPWrapper> {
    if (entry.sftp !== null && !entry.broken) return entry.sftp
    if (entry.connecting === null) {
      entry.connecting = (async () => {
        const server = this.requireServer(entry.serverId)
        try {
          const config = await connectConfig(server, this.config.connectTimeoutMs)
          await connectClient(entry.client, config)
          const sftp = await openSftp(entry.client)
          if (!entry.broken) {
            entry.sftp = sftp
            entry.connecting = null
          }
          return sftp
        } catch (error) {
          // Surface connection failures as wire errors; the entry stays
          // broken (ssh2 emitted 'close') so the next operation reconnects.
          entry.connecting = null
          throw remoteError('cannot connect to "' + server.name + '"', error)
        }
      })()
    }
    return entry.connecting
  }

  /** Arm (or re-arm) the idle close for one entry. */
  private scheduleIdle(entry: PoolEntry): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (Date.now() - entry.lastUsed >= this.config.idleTimeoutMs) {
        entry.broken = true
        entry.sftp = null
        entry.client.end()
        this.entries.delete(entry.serverId)
      } else {
        this.scheduleIdle(entry)
      }
    }, this.config.idleTimeoutMs)
    entry.idleTimer.unref?.()
  }

  /** Take a concurrency slot for one entry (resolve immediately while
   *  under the cap, park otherwise; released by {@link releaseSlot}). */
  private acquireSlot(entry: PoolEntry): Promise<void> {
    if (entry.inFlight < MAX_SFTP_CONCURRENCY) {
      entry.inFlight += 1
      return Promise.resolve()
    }
    return new Promise(resolve => { entry.waiters.push(resolve) })
  }

  /** Release one concurrency slot and admit the next parked operation. */
  private releaseSlot(entry: PoolEntry): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    const next = entry.waiters.shift()
    if (next !== undefined) {
      entry.inFlight += 1
      next()
    }
  }

  /** Run one SFTP operation, concurrent up to MAX_SFTP_CONCURRENCY per server. */
  async withSftp<T>(serverId: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const entry = await this.ensureEntry(serverId)
    await this.acquireSlot(entry)
    entry.lastUsed = Date.now()
    this.scheduleIdle(entry)
    try {
      const sftp = await this.sftpOf(entry)
      return await fn(sftp)
    } finally {
      this.releaseSlot(entry)
    }
  }

  /** Close one server's pooled connection (deleted server / teardown). */
  closeServer(serverId: string): void {
    const entry = this.entries.get(serverId)
    if (entry === undefined) return
    entry.broken = true
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    entry.client.end()
    this.entries.delete(serverId)
  }

  /** Close every pooled connection (plugin teardown). */
  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.closeServer(id)
  }

  /** One-off connection (server test + downloads): never enters the pool. */
  private async withFreshSftp<T>(server: RemoteServer, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = new Client()
    client.on('error', () => {})
    try {
      const config = await connectConfig(server, this.config.connectTimeoutMs)
      await connectClient(client, config)
      const sftp = await openSftp(client)
      try {
        return await fn(sftp)
      } finally {
        sftp.end()
      }
    } finally {
      client.end()
    }
  }

  /** Test one (possibly unsaved) server record; returns the login home. */
  async testConnection(server: RemoteServer): Promise<{ home: string }> {
    const home = await this.withFreshSftp(server, sftp => realpath(sftp, '.'))
    return { home }
  }

  /** Resolve the root directory of one server (rootPath or login home). */
  async rootOf(serverId: string): Promise<{ root: string; home: string }> {
    const server = this.requireServer(serverId)
    const home = await this.withSftp(serverId, sftp => realpath(sftp, '.'))
    const root = server.rootPath !== undefined && server.rootPath !== '' ? server.rootPath : home
    return { root, home }
  }

  /** List one remote directory level. */
  async listDir(serverId: string, path: string, limit: number): Promise<RemoteFsListing> {
    return this.withSftp(serverId, async (sftp) => {
      let dirents: RemoteDirent[]
      try {
        dirents = await readdirOf(sftp, path)
      } catch (error) {
        throw remoteError('cannot list "' + path + '"', error)
      }
      const rows: RemoteFsEntry[] = []
      let overflow = 0
      for (const d of dirents) {
        if (d.filename === '.' || d.filename === '..') continue
        if (rows.length >= limit) {
          overflow += 1
          continue
        }
        rows.push({
          name: d.filename,
          path: joinRemote(path, d.filename),
          isDir: d.attrs.isDirectory() && !d.attrs.isSymbolicLink(),
          isLink: d.attrs.isSymbolicLink(),
          size: d.attrs.size ?? 0,
          hidden: d.filename.startsWith('.'),
        })
      }
      rows.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })))
      return { path, entries: rows, truncated: overflow > 0 }
    })
  }

  /** Read one remote file (capped; NUL probe marks binaries). */
  async readFile(serverId: string, path: string, limit: number): Promise<RemoteFileRead> {
    return this.withSftp(serverId, async (sftp) => {
      let size: number
      let isDir: boolean
      try {
        const attrs = await statOf(sftp, path)
        size = attrs.size
        isDir = attrs.isDirectory()
      } catch (error) {
        throw remoteError('cannot read "' + path + '"', error)
      }
      if (isDir) throw new SidebarError('remote-error', '"' + path + '" is a directory', 400)
      const bytes = await readSome(sftp, path, Math.min(size, limit))
      const slice = bytes.subarray(0, bytes.length)
      const binary = slice.includes(0)
      if (binary) {
        const headLen = Math.min(slice.length, 4096)
        return {
          kind: 'binary',
          size,
          truncated: size > limit,
          head: slice.subarray(0, headLen).toString('base64'),
        }
      }
      return { kind: 'text', content: slice.toString('utf8'), truncated: size > limit }
    })
  }

  /** Atomic write: temp file in the same directory + rename. Accepts raw
   *  text or pre-encoded bytes (base64 uploads arrive as Buffers). */
  async writeFile(serverId: string, path: string, content: string | Buffer): Promise<void> {
    return this.withSftp(serverId, async (sftp) => {
      const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
      const tmp = path + '.dsh-sidebar-tmp-' + Date.now()
      try {
        await writeAll(sftp, tmp, data)
        try {
          await renameOf(sftp, tmp, path)
        } catch (error) {
          // Some servers refuse rename onto an existing file's odd modes;
          // a direct overwrite is the fallback (still same-directory-safe).
          await writeAll(sftp, path, data)
          await unlinkOf(sftp, tmp).catch(() => {})
        }
      } catch (error) {
        await unlinkOf(sftp, tmp).catch(() => {})
        throw remoteError('cannot write "' + path + '"', error)
      }
    })
  }

  /** Rename one entry (same directory; the new name must not contain '/'). */
  async renameEntry(serverId: string, path: string, newName: string): Promise<void> {
    if (newName === '' || newName === '.' || newName === '..' || newName.includes('/')) {
      throw new SidebarError('bad-request', 'invalid target name', 400)
    }
    const target = joinRemote(dirnameRemote(path), newName)
    return this.withSftp(serverId, async (sftp) => {
      try {
        await renameOf(sftp, path, target)
      } catch (error) {
        throw remoteError('cannot rename "' + path + '"', error)
      }
    })
  }

  /** Delete one entry (directories recurse children-first). */
  async deleteEntry(serverId: string, path: string): Promise<void> {
    return this.withSftp(serverId, async (sftp) => {
      await deleteRecursive(sftp, path)
    })
  }

  /** Stat one remote file (the download route's size/content-length). */
  async statFile(serverId: string, path: string): Promise<{ size: number }> {
    return this.withSftp(serverId, async (sftp) => {
      let attrs: RemoteDirent['attrs']
      try {
        attrs = await statOf(sftp, path)
      } catch (error) {
        throw remoteError('cannot stat "' + path + '"', error)
      }
      if (attrs.isDirectory()) throw new SidebarError('remote-error', '"' + path + '" is a directory', 400)
      return { size: attrs.size }
    })
  }

  /** Stream one remote file over a short-lived dedicated connection. */
  async downloadStream(serverId: string, path: string, onStream: (stream: Readable, size: number) => Promise<void>): Promise<void> {
    const server = this.requireServer(serverId)
    await this.withFreshSftp(server, async (sftp) => {
      let attrs: RemoteDirent['attrs']
      try {
        attrs = await statOf(sftp, path)
      } catch (error) {
        throw remoteError('cannot stat "' + path + '"', error)
      }
      if (attrs.isDirectory()) throw new SidebarError('remote-error', '"' + path + '" is a directory', 400)
      const stream = sftp.createReadStream(path)
      await onStream(stream, attrs.size)
    })
  }
}

// ── sftp callback helpers ─────────────────────────────────────────────────

function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (err, p) => (err !== undefined ? reject(err) : resolve(p)))
  })
}

function readdirOf(sftp: SFTPWrapper, path: string): Promise<RemoteDirent[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err !== undefined ? reject(err) : resolve(list as RemoteDirent[])))
  })
}

function statOf(sftp: SFTPWrapper, path: string): Promise<RemoteDirent['attrs']> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, attrs) => (err !== undefined ? reject(err) : resolve(attrs as RemoteDirent['attrs'])))
  })
}

/** Read at most `length` bytes from the start of one remote file. */
function readSome(sftp: SFTPWrapper, path: string, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'r', (openErr, handle) => {
      if (openErr !== undefined) { reject(openErr); return }
      const buffer = Buffer.alloc(length)
      let filled = 0
      const pump = (): void => {
        if (filled >= length) { closeHandle(); return }
        sftp.read(handle, buffer, filled, length - filled, filled, (readErr, bytesRead) => {
          if (readErr !== undefined) { closeHandle(); reject(readErr); return }
          if (bytesRead === 0) { closeHandle(); return }
          filled += bytesRead
          pump()
        })
      }
      const closeHandle = (): void => {
        sftp.close(handle, () => {})
        resolve(buffer.subarray(0, filled))
      }
      pump()
    })
  })
}

function writeAll(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'w', (openErr, handle) => {
      if (openErr !== undefined) { reject(openErr); return }
      sftp.write(handle, data, 0, data.length, 0, (writeErr) => {
        if (writeErr !== undefined) {
          sftp.close(handle, () => {})
          reject(writeErr)
          return
        }
        sftp.close(handle, (closeErr) => (closeErr !== undefined ? reject(closeErr) : resolve()))
      })
    })
  })
}

function renameOf(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) => (err !== undefined ? reject(err) : resolve()))
  })
}

function unlinkOf(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => (err !== undefined ? reject(err) : resolve()))
  })
}

function rmdirOf(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => (err !== undefined ? reject(err) : resolve()))
  })
}

/** Recursive delete (children first; symlinks unlink without following). */
async function deleteRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
  let attrs: RemoteDirent['attrs']
  try {
    attrs = await statOf(sftp, path)
  } catch (error) {
    throw remoteError('cannot delete "' + path + '"', error)
  }
  if (attrs.isDirectory() && !attrs.isSymbolicLink()) {
    const dirents = await readdirOf(sftp, path)
    for (const d of dirents) {
      if (d.filename === '.' || d.filename === '..') continue
      await deleteRecursive(sftp, joinRemote(path, d.filename))
    }
    await rmdirOf(sftp, path)
  } else {
    await unlinkOf(sftp, path)
  }
}

// ── remote path helpers (POSIX only) ──────────────────────────────────────

/** Join two remote path segments with '/'. */
export function joinRemote(base: string, name: string): string {
  return base.endsWith('/') ? base + name : base + '/' + name
}

/** The parent directory of a remote path ('/foo/bar' → '/foo'; '/' → '/'). */
export function dirnameRemote(path: string): string {
  const at = path.lastIndexOf('/')
  if (at <= 0) return '/'
  return path.slice(0, at)
}
