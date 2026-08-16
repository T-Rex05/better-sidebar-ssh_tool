/**
 * Remote SSH engine spec (host side): the server-list config store
 * (~/.dsh/better-sidebar-servers.json persistence, validation, secret
 * masking), the SFTP connection pool (lazy connect, per-server serialization,
 * broken reconnect, idle close, list/read/write/rename/delete semantics), and
 * the interactive shell registry (quota, transcript replay, reconnect grace,
 * cd quoting). ssh2 is mocked at the module level with a controllable fake
 * Client; the config store tests run against a temp HOME.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Fake ssh2 Client (module-level mock, shared by pool + registry) ───────

type Listener = (...args: unknown[]) => void

/** The fake classes must exist BEFORE the mocked 'ssh2' module is imported
 *  (imports run ahead of the module body), so they live in vi.hoisted. */
const h = vi.hoisted(() => {
  class FakeStream {
    writes: string[] = []
    ended = false
    private readonly listeners = new Map<string, Listener[]>()
    stderr = { on: (): void => {} }
    on(event: string, cb: Listener): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(event) ?? []) cb(...args)
    }
    write(text: string): boolean {
      this.writes.push(text)
      return true
    }
    end(): void {
      this.ended = true
    }
    setWindow(): void {}
  }

  class FakeSftp {
    calls: Array<{ method: string; args: unknown[] }> = []
    /** dirent rows per readdir path (default: empty). */
    direntsByPath: Record<string, Array<{ filename: string; attrs: Record<string, unknown> }>> = {}
    statResult: Record<string, { isDirectory: boolean; isSymbolicLink?: boolean; size: number }> = {}
    failMethods = new Set<string>()
    home = '/home/user'
    /** Payload served by read() (default empty). */
    readPayload = ''

    private record(method: string, args: unknown[]): void {
      this.calls.push({ method, args })
    }

    realpath(path: string, cb: (err: Error | undefined, p: string) => void): void {
      this.record('realpath', [path])
      if (this.failMethods.has('realpath')) { cb(new Error('realpath failed'), ''); return }
      cb(undefined, path === '.' ? this.home : path)
    }
    readdir(path: string, cb: (err: Error | undefined, list: unknown) => void): void {
      this.record('readdir', [path])
      if (this.failMethods.has('readdir')) { cb(new Error('readdir failed'), []); return }
      cb(undefined, this.direntsByPath[path] ?? [])
    }
    stat(path: string, cb: (err: Error | undefined, attrs: unknown) => void): void {
      this.record('stat', [path])
      if (this.failMethods.has('stat')) { cb(new Error('stat failed'), undefined); return }
      const hit = this.statResult[path] ?? { isDirectory: false, size: 10 }
      cb(undefined, {
        isDirectory: () => hit.isDirectory === true,
        isSymbolicLink: () => hit.isSymbolicLink === true,
        size: hit.size,
        mode: 0o644,
      })
    }
    open(path: string, _mode: string, cb: (err: Error | undefined, handle: Buffer) => void): void {
      this.record('open', [path])
      if (this.failMethods.has('open')) { cb(new Error('open failed'), Buffer.alloc(0)); return }
      cb(undefined, Buffer.from('h'))
    }
    read(
      _handle: Buffer, buffer: Buffer, offset: number, length: number, _position: number,
      cb: (err: Error | undefined, bytesRead: number) => void,
    ): void {
      this.record('read', [])
      if (this.failMethods.has('read')) { cb(new Error('read failed'), 0); return }
      const chunk = Buffer.from(this.readPayload)
      const n = Math.min(length, Math.max(0, chunk.length - offset))
      chunk.copy(buffer, offset, 0, n)
      cb(undefined, n)
    }
    write(
      _handle: Buffer, buffer: Buffer, _offset: number, _length: number, _position: number,
      cb: (err: Error | undefined) => void,
    ): void {
      this.record('write', [buffer.toString('utf8')])
      if (this.failMethods.has('write')) { cb(new Error('write failed')); return }
      cb(undefined)
    }
    close(_handle: Buffer, cb: (err: Error | undefined) => void): void {
      this.record('close', [])
      cb(undefined)
    }
    rename(oldPath: string, newPath: string, cb: (err: Error | undefined) => void): void {
      this.record('rename', [oldPath, newPath])
      if (this.failMethods.has('rename')) { cb(new Error('rename failed')); return }
      cb(undefined)
    }
    unlink(path: string, cb: (err: Error | undefined) => void): void {
      this.record('unlink', [path])
      cb(undefined)
    }
    rmdir(path: string, cb: (err: Error | undefined) => void): void {
      this.record('rmdir', [path])
      cb(undefined)
    }
    createReadStream(_path: string): FakeStream {
      return new FakeStream()
    }
  }

  class FakeClient {
    static instances: FakeClient[] = []
    static sftpImpl: FakeSftp = new FakeSftp()
    static shellStream: FakeStream = new FakeStream()
    static failConnect = false
    static failShell = false
    /** Emit 'ready' synchronously (microtask) unless failConnect. */
    static connectMode: 'ready' | 'manual' = 'ready'

    readonly listeners = new Map<string, Listener[]>()
    connectConfig: Record<string, unknown> | null = null
    ended = false
    sftpCalls = 0

    constructor() {
      FakeClient.instances.push(this)
    }
    on(event: string, cb: Listener): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    removeListener(event: string, cb: Listener): this {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter(fn => fn !== cb))
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
    }
    connect(config: Record<string, unknown>): void {
      this.connectConfig = config
      if (FakeClient.connectMode === 'ready' && !FakeClient.failConnect) {
        queueMicrotask(() => this.emit('ready'))
      } else if (FakeClient.failConnect) {
        // ssh2 emits 'error' then 'close' on a failed handshake; the pool's
        // close handler invalidates the entry so the next op reconnects.
        queueMicrotask(() => {
          this.emit('error', new Error('handshake failed'))
          this.emit('close')
        })
      }
    }
    sftp(cb: (err: Error | undefined, sftp: FakeSftp) => void): void {
      this.sftpCalls += 1
      cb(undefined, FakeClient.sftpImpl)
    }
    shell(_opts: unknown, cb: (err: Error | undefined, stream: FakeStream) => void): void {
      if (FakeClient.failShell) { cb(new Error('shell failed'), new h.FakeStream()); return }
      cb(undefined, FakeClient.shellStream)
    }
    end(): void {
      this.ended = true
      this.emit('close')
    }
  }

  return { FakeStream, FakeSftp, FakeClient }
})

vi.mock('ssh2', () => ({ Client: h.FakeClient }))

const FakeStream = h.FakeStream
const FakeSftp = h.FakeSftp
const FakeClient = h.FakeClient

// Wait for the fake client's microtask 'ready' to settle the connect promise.
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

// ── Config store (temp HOME) ───────────────────────────────────────────────

import {
  deleteServer, loadServers, maskServer, remoteConfigPath, saveServer, validateServer,
} from '../src/remote/config-store.ts'
import { importFromSshConfig, parseSshConfig, sshConfigPath } from '../src/remote/ssh-config.ts'
import { SftpPool } from '../src/remote/sftp-pool.ts'
import { RemoteShellRegistry } from '../src/remote/shell-registry.ts'
import { joinRemote, dirnameRemote } from '../src/remote/sftp-pool.ts'
import { SidebarError } from '../src/wire.ts'
import type { RemoteServer } from '../src/remote/types.ts'

/** Point os.homedir() at a temp dir (HOME on POSIX, USERPROFILE on Windows). */
function withTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-'))
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  ;(globalThis as Record<string, unknown>).__dshPrevHome = prevHome
  ;(globalThis as Record<string, unknown>).__dshPrevProfile = prevProfile
  return dir
}

function restoreHome(): void {
  const g = globalThis as Record<string, unknown>
  process.env.HOME = g.__dshPrevHome as string | undefined
  process.env.USERPROFILE = g.__dshPrevProfile as string | undefined
  const dir = g.__dshTempHome as string | undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  delete g.__dshTempHome
}

const serverInput = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'prod',
  host: '10.0.0.1',
  port: 22,
  username: 'deploy',
  authType: 'password',
  password: 's3cret',
  ...patch,
})

describe('remote server config store', () => {
  let home: string
  beforeEach(() => {
    home = withTempHome()
    ;(globalThis as Record<string, unknown>).__dshTempHome = home
  })
  afterEach(() => {
    restoreHome()
  })

  it('loads an empty list on first run (no config file yet)', async () => {
    expect(await loadServers()).toEqual([])
  })

  it('save persists and masks the record; empty password keeps the stored secret', async () => {
    const first = await saveServer(serverInput())
    expect(first.saved.password).toBe('s3cret')
    const listed = await loadServers()
    expect(listed).toHaveLength(1)
    // The persisted file itself holds the plaintext (local-machine tradeoff).
    const raw = JSON.parse(readFileSync(remoteConfigPath(), 'utf8')) as { servers: Array<{ password?: string }> }
    expect(raw.servers[0]!.password).toBe('s3cret')

    // Edit with an empty password keeps the stored one.
    const second = await saveServer(serverInput({ id: first.saved.id, password: '', name: 'prod-2' }))
    expect(second.saved.password).toBe('s3cret')
    expect(second.saved.name).toBe('prod-2')
    expect(second.servers).toHaveLength(1)
  })

  it('validates required fields, the port range, and absolute rootPath', async () => {
    for (const bad of [
      serverInput({ name: '' }),
      serverInput({ host: '' }),
      serverInput({ username: '' }),
      serverInput({ port: 0 }),
      serverInput({ port: 70000 }),
      serverInput({ authType: 'password', password: '' }),
      serverInput({ authType: 'privateKey' }), // no key path
      serverInput({ rootPath: 'relative/x' }),
    ]) {
      await expect(saveServer(bad)).rejects.toThrow(SidebarError)
    }
    // Key auth needs a readable key path (the path itself is validated later
    // at connect time, but the record must carry it).
    const keyed = await saveServer(serverInput({ authType: 'privateKey', privateKeyPath: 'C:/keys/id_rsa' }))
    expect(keyed.saved.authType).toBe('privateKey')
  })

  it('delete removes the row and persists', async () => {
    const { saved } = await saveServer(serverInput())
    const { saved: other } = await saveServer(serverInput({ name: 'staging', host: '10.0.0.2' }))
    const after = await deleteServer(saved.id)
    expect(after.map(s => s.id)).toEqual([other.id])
  })

  it('maskServer never leaks secrets across the wire shape', async () => {
    const { saved } = await saveServer(serverInput({ password: 's3cret' }))
    const masked = maskServer(saved)
    expect(masked.hasPassword).toBe(true)
    expect('password' in masked).toBe(false)
    expect(masked.hasPassphrase).toBe(false)
    const keyed = await saveServer(serverInput({ authType: 'privateKey', privateKeyPath: 'C:/keys/id_rsa', passphrase: 'pp' }))
    expect(maskServer(keyed.saved).hasPassphrase).toBe(true)
  })

  it('a corrupt config file yields an empty list instead of throwing', async () => {
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(remoteConfigPath(), 'not json{{{')
    expect(await loadServers()).toEqual([])
  })
})

// ── OpenSSH config parsing + import ────────────────────────────────────────

describe('OpenSSH config parsing', () => {
  it('parses Host blocks with HostName/User/Port/IdentityFile (case-insensitive)', () => {
    const entries = parseSshConfig(`
      # comment line
      Host web-prod
        HostName 10.0.0.5
        User deploy
        Port 2222
        IdentityFile ~/.ssh/web_prod

      Host db
        hostname db.internal
        user back
    `)
    expect(entries).toEqual([
      { host: 'web-prod', hostName: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '~/.ssh/web_prod' },
      { host: 'db', hostName: 'db.internal', user: 'back' },
    ])
  })

  it('applies Host * defaults to concrete aliases (first match wins)', () => {
    const entries = parseSshConfig(`
      Host *
        User common
        IdentityFile ~/.ssh/id_default
      Host app
        HostName app.example.com
      Host special
        HostName sp.example.com
        User override
    `)
    expect(entries).toEqual([
      { host: 'app', hostName: 'app.example.com', user: 'common', identityFile: '~/.ssh/id_default' },
      { host: 'special', hostName: 'sp.example.com', user: 'override', identityFile: '~/.ssh/id_default' },
    ])
  })

  it('skips wildcard aliases, flags ProxyJump entries, and tolerates junk lines', () => {
    const entries = parseSshConfig(`
      Host *.example.com
        HostName x
      Host jumpy
        HostName real-host
        ProxyJump bastion
      SomeUnknownKeyword value
      Host plain
    `)
    expect(entries).toEqual([
      { host: 'jumpy', hostName: 'real-host', proxyJump: 'bastion' },
      { host: 'plain' },
    ])
  })
})

describe('OpenSSH config import', () => {
  let home: string
  beforeEach(() => {
    home = withTempHome()
    ;(globalThis as Record<string, unknown>).__dshTempHome = home
  })
  afterEach(() => {
    restoreHome()
  })

  it('imports ~/.ssh/config entries, skipping duplicates, ProxyJump and keyless hosts', async () => {
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'config'), `
      Host gitlab
        HostName gitlab.example.com
        User git
        IdentityFile ~/.ssh/gitlab
      Host jump-only
        HostName behind.example.com
        ProxyJump bastion
      Host no-key
        HostName agent-only.example.com
    `)
    const result = await importFromSshConfig()
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(2) // ProxyJump + no IdentityFile
    const servers = await loadServers()
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({
      name: 'gitlab',
      host: 'gitlab.example.com',
      port: 22,
      username: 'git',
      authType: 'privateKey',
      privateKeyPath: join(home, '.ssh', 'gitlab'),
    })
    // A second import skips the now-existing name.
    const again = await importFromSshConfig()
    expect(again.imported).toBe(0)
    expect(again.skipped).toBe(3)
  })

  it('importing without a config file is a benign no-op', async () => {
    const result = await importFromSshConfig()
    expect(result).toEqual({ imported: 0, skipped: 0, reason: 'no-config' })
    expect(await loadServers()).toEqual([])
  })
})

// ── SFTP pool ──────────────────────────────────────────────────────────────

const sftp = (): InstanceType<typeof FakeSftp> => FakeClient.sftpImpl

const server = (patch: Partial<RemoteServer> = {}): RemoteServer => ({
  id: 'srv-1',
  name: 'prod',
  host: '10.0.0.1',
  port: 22,
  username: 'deploy',
  authType: 'password',
  password: 's3cret',
  ...patch,
})

const pool = (overrides: Partial<{ idleTimeoutMs: number; connectTimeoutMs: number }> = {}): SftpPool =>
  new SftpPool({ connectTimeoutMs: overrides.connectTimeoutMs ?? 1000, idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000 })

describe('SFTP pool', () => {
  beforeEach(() => {
    FakeClient.instances = []
    FakeClient.sftpImpl = new FakeSftp()
    FakeClient.connectMode = 'ready'
    FakeClient.failConnect = false
  })

  it('connects lazily and reuses one client per server', async () => {
    const p = pool()
    p.syncServers([server()])
    const first = await p.listDir('srv-1', '/', 100)
    expect(first.entries).toEqual([])
    expect(FakeClient.instances).toHaveLength(1)
    await p.listDir('srv-1', '/', 100)
    expect(FakeClient.instances).toHaveLength(1)
    expect(FakeClient.instances[0]!.connectConfig).toMatchObject({ host: '10.0.0.1', port: 22, username: 'deploy', password: 's3cret' })
  })

  it('lists dirs first, marks hidden entries, joins paths, and truncates at the limit', async () => {
    sftp().direntsByPath['/'] = [
      { filename: 'b.txt', attrs: { isDirectory: () => false, isSymbolicLink: () => false, size: 5 } },
      { filename: '.env', attrs: { isDirectory: () => false, isSymbolicLink: () => false, size: 2 } },
      { filename: 'a-dir', attrs: { isDirectory: () => true, isSymbolicLink: () => false, size: 0 } },
      { filename: 'link', attrs: { isDirectory: () => true, isSymbolicLink: () => true, size: 0 } },
    ]
    const p = pool()
    p.syncServers([server()])
    const listing = await p.listDir('srv-1', '/', 3)
    // Dirs first; files in ICU base-sensitive order ('.env' collates before
    // 'b.txt' — punctuation precedes letters in localeCompare).
    expect(listing.entries.map(e => e.name)).toEqual(['a-dir', '.env', 'b.txt'])
    expect(listing.entries[0]).toMatchObject({ path: '/a-dir', isDir: true, isLink: false })
    expect(listing.entries[1]).toMatchObject({ path: '/.env', isDir: false, hidden: true })
    expect(listing.entries[2]).toMatchObject({ path: '/b.txt', isDir: false })
    expect(listing.truncated).toBe(true) // 'link' overflowed the limit of 3
  })

  it('reads text files and NUL-probes binaries (head bytes + size)', async () => {
    sftp().readPayload = 'hello\x00world'
    sftp().statResult['/bin'] = { isDirectory: false, size: 11 }
    const p = pool()
    p.syncServers([server()])
    const result = await p.readFile('srv-1', '/bin', 64)
    expect(result.kind).toBe('binary')
    if (result.kind === 'binary') {
      expect(result.size).toBe(11)
      expect(Buffer.from(result.head, 'base64').toString('utf8')).toBe('hello\x00world')
    }
    sftp().readPayload = 'plain text'
    sftp().statResult['/txt'] = { isDirectory: false, size: 10 }
    const text = await p.readFile('srv-1', '/txt', 64)
    expect(text.kind).toBe('text')
    if (text.kind === 'text') expect(text.content).toBe('plain text')
    // A directory read is refused.
    sftp().statResult['/dir'] = { isDirectory: true, size: 0 }
    await expect(p.readFile('srv-1', '/dir', 64)).rejects.toThrow(SidebarError)
  })

  it('writes through temp + rename (falling back to a direct overwrite)', async () => {
    const p = pool()
    p.syncServers([server()])
    await p.writeFile('srv-1', '/a.txt', 'content')
    const renameCall = sftp().calls.find(c => c.method === 'rename')
    expect(renameCall).toBeDefined()
    expect(renameCall!.args[0]).toMatch(/^\/a\.txt\.dsh-sidebar-tmp-\d+$/)

    // Rename refused → direct overwrite fallback.
    sftp().failMethods.add('rename')
    await p.writeFile('srv-1', '/a.txt', 'content')
    const writes = sftp().calls.filter(c => c.method === 'write').map(c => c.args[0])
    expect(writes).toContain('content')
  })

  it('rejects an invalid rename target name', async () => {
    const p = pool()
    p.syncServers([server()])
    for (const bad of ['', '.', '..', 'a/b']) {
      await expect(p.renameEntry('srv-1', '/x.txt', bad)).rejects.toThrow(SidebarError)
    }
  })

  it('deletes directories recursively (children first)', async () => {
    sftp().statResult['/d'] = { isDirectory: true, size: 0 }
    sftp().statResult['/d/f.txt'] = { isDirectory: false, size: 1 }
    sftp().statResult['/d/sub'] = { isDirectory: true, size: 0 }
    sftp().direntsByPath['/d'] = [
      { filename: 'f.txt', attrs: { isDirectory: () => false, isSymbolicLink: () => false, size: 1 } },
      { filename: 'sub', attrs: { isDirectory: () => true, isSymbolicLink: () => false, size: 0 } },
    ]
    const p = pool()
    p.syncServers([server()])
    await p.deleteEntry('srv-1', '/d')
    const unlinks = sftp().calls.filter(c => c.method === 'unlink').map(c => c.args[0])
    const rmdirs = sftp().calls.filter(c => c.method === 'rmdir').map(c => c.args[0])
    expect(unlinks).toEqual(['/d/f.txt'])
    expect(rmdirs).toEqual(['/d/sub', '/d'])
  })

  it('a dropped connection invalidates the entry and the next op reconnects', async () => {
    const p = pool()
    p.syncServers([server()])
    await p.listDir('srv-1', '/', 100)
    expect(FakeClient.instances).toHaveLength(1)
    FakeClient.instances[0]!.emit('close')
    await p.listDir('srv-1', '/', 100)
    expect(FakeClient.instances).toHaveLength(2)
    expect(FakeClient.instances[0]!.ended).toBe(true) // the broken client was ended
  })

  it('a failed handshake surfaces the error and does not cache the entry', async () => {
    FakeClient.failConnect = true
    const p = pool()
    p.syncServers([server()])
    await expect(p.listDir('srv-1', '/', 100)).rejects.toThrow(SidebarError)
    // The broken entry is discarded: a later success reconnects.
    FakeClient.failConnect = false
    const listing = await p.listDir('srv-1', '/', 100)
    expect(listing.entries).toEqual([])
    expect(FakeClient.instances).toHaveLength(2)
  })

  it('runs operations concurrently up to the cap (no serialization)', async () => {
    const p = pool()
    p.syncServers([server()])
    const seen: string[] = []
    let inFlight = 0
    let peak = 0
    const gates: Array<() => void> = []
    sftp().readdir = (path: string, cb: (err: Error | undefined, list: unknown) => void): void => {
      seen.push(path)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      gates.push(() => {
        inFlight -= 1
        cb(undefined, [])
      })
    }
    const paths = ['/a', '/b', '/c', '/d', '/e', '/f']
    const all = paths.map(path => p.listDir('srv-1', path, 100))
    // Let the 6 operations reach their readdir (each async hop needs a
    // microtask; a macrotask flushes the whole chain): 4 in flight, 2 queued.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(peak).toBeLessThanOrEqual(4)
    expect(gates).toHaveLength(4)
    // Release the first batch: the two queued operations then run.
    for (const gate of gates.splice(0)) gate()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(peak).toBeLessThanOrEqual(4)
    expect(gates).toHaveLength(2)
    for (const gate of gates.splice(0)) gate()
    await Promise.all(all)
    expect(seen.sort()).toEqual([...paths].sort())
    expect(peak).toBeGreaterThan(1) // genuinely concurrent, not serialized
  })

  it('reconnects after an idle close', async () => {
    vi.useFakeTimers()
    try {
      const p = pool({ idleTimeoutMs: 50 })
      p.syncServers([server()])
      await p.listDir('srv-1', '/a', 100)
      await vi.advanceTimersByTimeAsync(100)
      expect(FakeClient.instances[0]!.ended).toBe(true)
      await p.listDir('srv-1', '/b', 100)
      expect(FakeClient.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closeServer / closeAll release pooled connections', async () => {
    const p = pool()
    p.syncServers([server(), server({ id: 'srv-2', name: 'staging' })])
    await p.listDir('srv-1', '/', 100)
    await p.listDir('srv-2', '/', 100)
    p.closeServer('srv-1')
    expect(FakeClient.instances[0]!.ended).toBe(true)
    expect(FakeClient.instances[1]!.ended).toBe(false)
    p.closeAll()
    expect(FakeClient.instances[1]!.ended).toBe(true)
  })

  it('resolves the root as rootPath or the login home', async () => {
    const p = pool()
    p.syncServers([server(), server({ id: 'srv-2', rootPath: '/var/www' })])
    expect((await p.rootOf('srv-1')).root).toBe('/home/user')
    expect((await p.rootOf('srv-2')).root).toBe('/var/www')
    await expect(p.rootOf('unknown')).rejects.toThrow(SidebarError)
  })

  it('joinRemote / dirnameRemote follow POSIX semantics', () => {
    expect(joinRemote('/a', 'b')).toBe('/a/b')
    expect(joinRemote('/a/', 'b')).toBe('/a/b')
    expect(dirnameRemote('/foo/bar')).toBe('/foo')
    expect(dirnameRemote('/foo')).toBe('/')
    expect(dirnameRemote('/')).toBe('/')
  })
})

// ── Remote shell registry ──────────────────────────────────────────────────

const shellServer = (): RemoteServer => server()

describe('remote shell registry', () => {
  beforeEach(() => {
    FakeClient.instances = []
    FakeClient.shellStream = new FakeStream()
    FakeClient.failShell = false
  })

  const registry = (overrides: Partial<{ perSession: number; graceMs: number }> = {}): RemoteShellRegistry =>
    new RemoteShellRegistry(
      {
        connectTimeoutMs: 1000,
        terminalsPerSession: overrides.perSession ?? 2,
        reconnectGraceMs: overrides.graceMs ?? 30_000,
      },
      (serverId) => serverId === 'srv-1' ? shellServer() : undefined,
    )

  it('opens a shell (idempotent per key) and lands in the requested dir with quoting', async () => {
    const r = registry()
    const handle = await r.open('s1', 'srv-1', 't1', "/a b'c", 80, 24)
    expect(FakeClient.instances).toHaveLength(1)
    expect(FakeClient.shellStream.writes).toEqual(["cd -- '/a b'\\''c'\r"])
    // Reopening the same key returns the SAME shell (no second client).
    expect(await r.open('s1', 'srv-1', 't1', '', 80, 24)).toBe(handle)
    expect(FakeClient.instances).toHaveLength(1)
    // Root dir: no cd preamble.
    FakeClient.shellStream.writes = []
    await r.open('s2', 'srv-1', 't2', '/', 80, 24)
    expect(FakeClient.shellStream.writes).toEqual([])
  })

  it('enforces the per-session quota', async () => {
    const r = registry({ perSession: 1 })
    await r.open('s1', 'srv-1', 't1', '', 80, 24)
    await expect(r.open('s1', 'srv-1', 't2', '', 80, 24)).rejects.toThrow(SidebarError)
    // Another session has its own quota.
    await r.open('s2', 'srv-1', 't3', '', 80, 24)
  })

  it('rejects an unknown server', async () => {
    const r = registry()
    await expect(r.open('s1', 'nope', 't1', '', 80, 24)).rejects.toThrow(SidebarError)
    expect(FakeClient.instances).toHaveLength(0)
  })

  it('replays the transcript on attach and broadcasts output to every socket', async () => {
    const r = registry()
    const handle = await r.open('s1', 'srv-1', 't1', '', 80, 24)
    FakeClient.shellStream.emit('data', Buffer.from('hello'))
    const a = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as { OPEN: number; readyState: number; send: ReturnType<typeof vi.fn> }
    r.attach(handle, a as never)
    expect(a.send).toHaveBeenCalledWith('hello')
    FakeClient.shellStream.emit('data', Buffer.from(' world'))
    expect(a.send).toHaveBeenLastCalledWith(' world')
    const b = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as { OPEN: number; readyState: number; send: ReturnType<typeof vi.fn> }
    r.attach(handle, b as never)
    FakeClient.shellStream.emit('data', Buffer.from('!'))
    expect(a.send).toHaveBeenLastCalledWith('!')
    expect(b.send).toHaveBeenCalledWith('!')
    expect(r.get('s1:t1')).toBe(handle)
  })

  it('detach schedules the reconnect-grace close; reattach cancels it', async () => {
    vi.useFakeTimers()
    try {
      const r = registry({ graceMs: 100 })
      const handle = await r.open('s1', 'srv-1', 't1', '', 80, 24)
      const a = { readyState: 1, send: () => {} } as never
      r.attach(handle, a)
      r.detach(handle, a)
      expect(r.get('s1:t1')).toBe(handle)
      r.attach(handle, a) // reattach before the grace elapses
      await vi.advanceTimersByTimeAsync(200)
      expect(r.get('s1:t1')).toBe(handle)
      r.detach(handle, a)
      await vi.advanceTimersByTimeAsync(200)
      expect(r.get('s1:t1')).toBeUndefined()
      expect(FakeClient.instances[0]!.ended).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('close kills the shell and closes its sockets immediately', async () => {
    const r = registry()
    const handle = await r.open('s1', 'srv-1', 't1', '', 80, 24)
    const a = { readyState: 1, close: vi.fn(), send: () => {} } as unknown as { readyState: number; close: ReturnType<typeof vi.fn> }
    r.attach(handle, a as never)
    r.close('s1:t1')
    expect(r.get('s1:t1')).toBeUndefined()
    expect(a.close).toHaveBeenCalled()
    expect(FakeClient.instances[0]!.ended).toBe(true)
    // A redundant close is a no-op.
    r.close('s1:t1')
  })

  it('write/resize are ignored after exit; the exit notice is broadcast', async () => {
    const r = registry()
    const handle = await r.open('s1', 'srv-1', 't1', '', 80, 24)
    const a = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as { OPEN: number; readyState: number; send: ReturnType<typeof vi.fn> }
    r.attach(handle, a as never)
    FakeClient.shellStream.emit('close', 0, undefined)
    expect(a.send).toHaveBeenCalledWith(expect.stringContaining('[process exited with code 0]'))
    r.write(handle, 'x')
    r.resize(handle, 100, 40)
    expect(FakeClient.shellStream.writes).toEqual([])
    expect(FakeClient.instances[0]!.ended).toBe(true)
  })

  it('replaces an exited shell on reopen (auto-reconnect semantics)', async () => {
    const r = registry()
    const first = await r.open('s1', 'srv-1', 't1', '', 80, 24)
    const a = {
      OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(),
    } as unknown as { OPEN: number; readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
    r.attach(first, a as never)
    // The SSH connection drops: the shell channel closes unexpectedly.
    FakeClient.shellStream.emit('close', 1, undefined)
    expect(first.exited).toBe(true)
    // The viewer socket is closed with 1001 so the client reconnects.
    expect(a.close).toHaveBeenCalledWith(1001, 'shell exited, reconnecting')
    // Reopen: the dead handle is replaced with a FRESH shell.
    const second = await r.open('s1', 'srv-1', 't1', '', 80, 24)
    expect(second).not.toBe(first)
    expect(second.exited).toBe(false)
    expect(FakeClient.instances).toHaveLength(2)
  })

  it('disposeAll closes every shell', async () => {
    const r = registry()
    await r.open('s1', 'srv-1', 't1', '', 80, 24)
    await r.open('s2', 'srv-1', 't2', '', 80, 24)
    r.disposeAll()
    expect(FakeClient.instances.every(c => c.ended)).toBe(true)
  })
})
