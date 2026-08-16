/**
 * Registry of interactive remote shells (the Start SSH Session terminals).
 * Each open() creates a DEDICATED ssh2 client + pty shell per
 * `${sessionId}:${tabId}` key — independent from the SFTP pool, so a pool
 * idle-close or a server delete never kills an open terminal. Multiple
 * WebSocket viewers may attach to one shell (session-switch/reconnect
 * overlap); input/resize apply to the pty, output broadcasts to every
 * socket and appends to a bounded transcript for reconnects.
 */
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { readFile } from 'node:fs/promises'
import { SidebarError } from '../wire.ts'
import type { RemoteServer } from './types.ts'
import type { WebSocket } from 'ws'

/** Shell registry knobs. */
export interface RemoteShellConfig {
  /** Connect timeout for one shell client (ms). */
  connectTimeoutMs: number
  /** Per-session quota of open remote shells. */
  terminalsPerSession: number
  /** How long a shell survives with no attached socket (ms). */
  reconnectGraceMs: number
}

/** One shell instance. */
export interface RemoteShellHandle {
  key: string
  sessionId: string
  serverId: string
  tabId: string
  dir: string
  client: Client
  stream: ClientChannel
  transcript: string
  exited: boolean
  exitDetail: string
  closing: boolean
  closeTimer: NodeJS.Timeout | null
  sockets: Set<WebSocket>
}

/** Cap of the replayed transcript (tail kept once exceeded). */
const TRANSCRIPT_CAP = 256 * 1024

/** Append output to the transcript, keeping only the tail. */
function appendTranscript(handle: RemoteShellHandle, text: string): void {
  handle.transcript += text
  if (handle.transcript.length > TRANSCRIPT_CAP) {
    handle.transcript = handle.transcript.slice(-TRANSCRIPT_CAP)
  }
}

/** POSIX single-quote escaping of the cd argument. */
function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'"
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RemoteShellRegistry {
  private readonly handles = new Map<string, RemoteShellHandle>()

  constructor(
    private readonly config: RemoteShellConfig,
    private readonly serverOf: (serverId: string) => RemoteServer | undefined,
  ) {}

  /** Count the shells of one session (the quota). */
  private sessionCount(sessionId: string): number {
    let count = 0
    for (const h of this.handles.values()) if (h.sessionId === sessionId) count += 1
    return count
  }

  /** Open (or reuse) one shell. Idempotent per key; an EXITED handle is
   *  replaced with a fresh shell (auto-reconnect semantics — a dropped SSH
   *  connection kills the shell, the client reattaches, and the registry
   *  spawns a new one instead of handing back a dead handle). */
  async open(
    sessionId: string,
    serverId: string,
    tabId: string,
    dir: string,
    cols: number,
    rows: number,
  ): Promise<RemoteShellHandle> {
    const key = sessionId + ':' + tabId
    const existing = this.handles.get(key)
    if (existing !== undefined && !existing.exited) return existing
    if (existing !== undefined) {
      // The previous shell died (or is closing): drop it, then respawn.
      this.handles.delete(key)
      existing.closing = true
      if (existing.closeTimer !== null) {
        clearTimeout(existing.closeTimer)
        existing.closeTimer = null
      }
      try { existing.stream.end() } catch { /* already closed */ }
      existing.client.end()
      for (const socket of [...existing.sockets]) {
        try { socket.close(1001, 'shell exited, reconnecting') } catch { /* ignore */ }
      }
      existing.sockets.clear()
    }
    if (this.sessionCount(sessionId) >= this.config.terminalsPerSession) {
      throw new SidebarError('remote-error', 'remote terminal quota reached for this session', 429)
    }
    const server = this.serverOf(serverId)
    if (server === undefined) throw new SidebarError('remote-error', 'unknown server "' + serverId + '"', 404)
    const handle = await this.create(sessionId, serverId, tabId, dir, cols, rows, server, key)
    this.handles.set(key, handle)
    return handle
  }

  /** Connect one shell client and open its pty. */
  private async create(
    sessionId: string,
    serverId: string,
    tabId: string,
    dir: string,
    cols: number,
    rows: number,
    server: RemoteServer,
    key: string,
  ): Promise<RemoteShellHandle> {
    const client = new Client()
    client.on('error', () => {})
    const handle: RemoteShellHandle = {
      key,
      sessionId,
      serverId,
      tabId,
      dir,
      client,
      stream: null as unknown as ClientChannel,
      transcript: '',
      exited: false,
      exitDetail: '',
      closing: false,
      closeTimer: null,
      sockets: new Set(),
    }
    try {
      await connectClient(client, await connectConfig(server, this.config.connectTimeoutMs))
      const stream = await openShell(client, cols, rows)
      handle.stream = stream
      stream.on('data', (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf8')
        appendTranscript(handle, text)
        for (const socket of [...handle.sockets]) {
          if (socket.readyState === socket.OPEN) socket.send(text)
        }
      })
      stream.on('close', (code?: number, signal?: string) => {
        handle.exited = true
        handle.exitDetail = signal !== undefined && signal !== '' ? ('signal ' + signal) : ('code ' + String(code ?? 0))
        const text = '\r\n[process exited with ' + handle.exitDetail + ']\r\n'
        appendTranscript(handle, text)
        for (const socket of [...handle.sockets]) {
          if (socket.readyState === socket.OPEN) socket.send(text)
        }
        // An UNEXPECTED exit (SSH connection dropped, shell died): close the
        // viewer sockets so the client reconnects — open() then spawns a
        // fresh shell instead of handing back this dead handle. A deliberate
        // close() already closed the sockets (1000) and set handle.closing.
        if (!handle.closing) {
          for (const socket of [...handle.sockets]) {
            try { socket.close(1001, 'shell exited, reconnecting') } catch { /* ignore */ }
          }
          handle.sockets.clear()
        }
        client.end()
      })
      stream.stderr?.on('data', (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf8')
        appendTranscript(handle, text)
        for (const socket of [...handle.sockets]) {
          if (socket.readyState === socket.OPEN) socket.send(text)
        }
      })
      // Land the shell in the requested directory (POSIX login shells).
      if (dir !== '' && dir !== '/') {
        stream.write('cd -- ' + shellQuote(dir) + '\r')
      }
      return handle
    } catch (error) {
      client.end()
      throw new SidebarError('remote-error', 'cannot open remote shell: ' + messageOf(error), 502)
    }
  }

  /** The handle of one key, if open. */
  get(key: string): RemoteShellHandle | undefined {
    return this.handles.get(key)
  }

  /** Attach one viewer socket (transcript replay + live broadcast). */
  attach(handle: RemoteShellHandle, socket: WebSocket): void {
    if (handle.closeTimer !== null) {
      clearTimeout(handle.closeTimer)
      handle.closeTimer = null
    }
    handle.sockets.add(socket)
    if (handle.transcript !== '' && socket.readyState === socket.OPEN) {
      socket.send(handle.transcript)
    }
  }

  /** Detach one viewer; an empty shell waits the reconnect grace. */
  detach(handle: RemoteShellHandle, socket: WebSocket): void {
    handle.sockets.delete(socket)
    this.scheduleClose(handle, this.config.reconnectGraceMs)
  }

  /** Schedule the close of an unattached shell (cancelled by a reattach). */
  scheduleClose(handle: RemoteShellHandle, graceMs: number): void {
    if (handle.closing || handle.closeTimer !== null) return
    handle.closeTimer = setTimeout(() => {
      handle.closeTimer = null
      if (handle.sockets.size === 0) this.close(handle.key)
    }, graceMs)
    handle.closeTimer.unref?.()
  }

  /** Write input to the pty. */
  write(handle: RemoteShellHandle, text: string): void {
    if (!handle.exited && !handle.closing) handle.stream.write(text)
  }

  /** Resize the pty. */
  resize(handle: RemoteShellHandle, cols: number, rows: number): void {
    if (handle.exited || handle.closing) return
    try {
      handle.stream.setWindow(rows, cols, 0, 0)
    } catch {
      // The pty may be mid-close; ignore.
    }
  }

  /** Close one shell immediately (tab closed / HTTP fallback / teardown). */
  close(key: string): void {
    const handle = this.handles.get(key)
    if (handle === undefined) return
    this.handles.delete(key)
    handle.closing = true
    if (handle.closeTimer !== null) {
      clearTimeout(handle.closeTimer)
      handle.closeTimer = null
    }
    try { handle.stream.end() } catch { /* already closed */ }
    handle.client.end()
    for (const socket of [...handle.sockets]) {
      try { socket.close(1000, 'shell closed') } catch { /* ignore */ }
    }
    handle.sockets.clear()
  }

  /** Close every shell (plugin teardown). */
  disposeAll(): void {
    for (const key of [...this.handles.keys()]) this.close(key)
  }
}

// ── ssh2 helpers ───────────────────────────────────────────────────────────

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
    const keyPath = server.privateKeyPath ?? ''
    if (keyPath === '') throw new Error('no private key path configured')
    config.privateKey = await readFile(keyPath, 'utf8')
    if (server.passphrase !== undefined && server.passphrase !== '') config.passphrase = server.passphrase
  }
  return config
}

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

function openShell(client: Client, cols: number, rows: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err !== undefined) reject(err)
      else resolve(stream)
    })
  })
}
