/**
 * Host-side persistence of the remote server list. One JSON file per user
 * under the DSH home (~/.dsh/better-sidebar-servers.json), written
 * atomically (temp + rename) and chmod 0600 on POSIX — the same plaintext
 * tradeoff the dsh-ssh plugin documents for dsh-ssh.json.
 *
 * Every read/write is defensive: a missing/corrupt file yields an empty
 * list (with a console warning) instead of throwing, so the plugin mounts
 * in any environment (tests, headless compositions, no HOME).
 */
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SidebarError } from '../wire.ts'
import type { RemoteServer, RemoteServerSafe } from './types.ts'

/** File format version (bumped on shape changes; unknown versions reset). */
const FILE_VERSION = 1

/** The FIRST existing default OpenSSH private key in ~/.ssh (id_ed25519 →
 *  id_ecdsa → id_rsa → id_dsa), or undefined when none exists. Lets a
 *  private-key server be saved WITHOUT typing a key path (PyCharm-style:
 *  the standard key just works). */
export function resolveDefaultKeyPath(): string | undefined {
  const sshDir = join(homedir(), '.ssh')
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']) {
    const candidate = join(sshDir, name)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable dir: try the next candidate.
    }
  }
  return undefined
}

/** The config file path (absolute). */
export function remoteConfigPath(): string {
  return join(homedir(), '.dsh', 'better-sidebar-servers.json')
}

/** One on-disk document. */
interface RemoteConfigDoc {
  version: number
  servers: RemoteServer[]
}

/** Validate one unknown value into a RemoteServer list (tolerant per row). */
function parseServers(value: unknown): RemoteServer[] {
  if (value === null || typeof value !== 'object') return []
  const doc = value as { version?: unknown; servers?: unknown }
  if (doc.version !== FILE_VERSION || !Array.isArray(doc.servers)) return []
  const servers: RemoteServer[] = []
  for (const row of doc.servers) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id === '') continue
    if (typeof r.name !== 'string') continue
    if (typeof r.host !== 'string' || r.host === '') continue
    if (typeof r.port !== 'number' || !Number.isInteger(r.port)) continue
    if (typeof r.username !== 'string' || r.username === '') continue
    if (r.authType !== 'password' && r.authType !== 'privateKey') continue
    servers.push({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      username: r.username,
      authType: r.authType,
      ...(typeof r.password === 'string' && r.password !== '' ? { password: r.password } : {}),
      ...(typeof r.privateKeyPath === 'string' && r.privateKeyPath !== '' ? { privateKeyPath: r.privateKeyPath } : {}),
      ...(typeof r.passphrase === 'string' && r.passphrase !== '' ? { passphrase: r.passphrase } : {}),
      ...(typeof r.rootPath === 'string' && r.rootPath !== '' ? { rootPath: r.rootPath } : {}),
    })
  }
  return servers
}

/** Read the persisted list (empty + warning on any failure). */
export async function loadServers(): Promise<RemoteServer[]> {
  try {
    const raw = await readFile(remoteConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parseServers(parsed)
  } catch (error) {
    const code = error as { code?: string }
    // ENOENT is the normal first-run case, not an error worth logging.
    if (code?.code !== 'ENOENT') {
      console.warn('[dsh-better-sidebar] cannot read remote server config:', error)
    }
    return []
  }
}

/** Atomic write of the current list (temp + rename; 0600 on POSIX). */
export async function persistServers(servers: RemoteServer[]): Promise<void> {
  const file = remoteConfigPath()
  const tmp = file + '.tmp-' + process.pid
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, servers }, null, 2), 'utf8')
    if (process.platform !== 'win32') {
      try { await chmod(tmp, 0o600) } catch { /* best-effort */ }
    }
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw new SidebarError('remote-error', 'cannot write remote server config: ' + (error instanceof Error ? error.message : String(error)), 500)
  }
}

/**
 * Validate one client-supplied server record (new or edit). `password` /
 * `passphrase` empty means keep the previously stored secret; the caller
 * fills hasPassword/hasPassphrase from the current row before calling.
 * @returns a clean RemoteServer (id minted when absent).
 */
export function validateServer(input: unknown, existing?: RemoteServer): RemoteServer {
  const r = (input === null || typeof input !== 'object' ? {} : input) as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const host = typeof r.host === 'string' ? r.host.trim() : ''
  const username = typeof r.username === 'string' ? r.username.trim() : ''
  const port = typeof r.port === 'number' ? r.port : NaN
  if (name === '') throw new SidebarError('bad-request', 'server name is required')
  if (host === '') throw new SidebarError('bad-request', 'server host is required')
  if (username === '') throw new SidebarError('bad-request', 'server username is required')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SidebarError('bad-request', 'server port must be an integer between 1 and 65535')
  }
  const authType = r.authType === 'privateKey' ? 'privateKey' : 'password'
  const password = typeof r.password === 'string' && r.password !== '' ? r.password : undefined
  const privateKeyPath = typeof r.privateKeyPath === 'string' && r.privateKeyPath.trim() !== '' ? r.privateKeyPath.trim() : undefined
  const passphrase = typeof r.passphrase === 'string' && r.passphrase !== '' ? r.passphrase : undefined
  const rootPath = typeof r.rootPath === 'string' && r.rootPath.trim() !== '' ? r.rootPath.trim() : undefined
  if (rootPath !== undefined && !rootPath.startsWith('/')) {
    throw new SidebarError('bad-request', 'rootPath must be an absolute POSIX path')
  }
  if (authType === 'password' && password === undefined && (existing === undefined || existing.password === undefined || existing.password === '')) {
    throw new SidebarError('bad-request', 'a password is required for password authentication')
  }
  // An empty key path falls back to the standard ~/.ssh default key
  // (id_ed25519 → id_ecdsa → id_rsa → id_dsa) — no password, no path typing.
  const defaultKeyPath = authType === 'privateKey' && privateKeyPath === undefined
    ? resolveDefaultKeyPath()
    : undefined
  const effectiveKeyPath = privateKeyPath ?? defaultKeyPath
  if (authType === 'privateKey' && effectiveKeyPath === undefined
    && (existing === undefined || existing.privateKeyPath === undefined || existing.privateKeyPath === '')) {
    throw new SidebarError('bad-request', 'a private key path is required (and no default key exists in ~/.ssh)')
  }
  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : randomUUID(),
    name,
    host,
    port,
    username,
    authType,
    ...(password !== undefined ? { password } : (existing !== undefined && existing.password !== undefined ? { password: existing.password } : {})),
    ...(effectiveKeyPath !== undefined
      ? { privateKeyPath: effectiveKeyPath }
      : (existing !== undefined && existing.privateKeyPath !== undefined ? { privateKeyPath: existing.privateKeyPath } : {})),
    ...(passphrase !== undefined ? { passphrase } : (existing !== undefined && existing.passphrase !== undefined ? { passphrase: existing.passphrase } : {})),
    ...(rootPath !== undefined ? { rootPath } : (existing !== undefined && existing.rootPath !== undefined ? { rootPath: existing.rootPath } : {})),
  }
}

/** Upsert one server and persist. @returns the new list (full records). */
export async function saveServer(input: unknown): Promise<{ servers: RemoteServer[]; saved: RemoteServer }> {
  const servers = await loadServers()
  const id = (input as Record<string, unknown> | null)?.id
  const existing = typeof id === 'string' ? servers.find(s => s.id === id) : undefined
  const saved = validateServer(input, existing)
  const index = servers.findIndex(s => s.id === saved.id)
  if (index === -1) servers.push(saved)
  else servers[index] = saved
  await persistServers(servers)
  return { servers, saved }
}

/** Delete one server by id and persist. @returns the new list. */
export async function deleteServer(id: string): Promise<RemoteServer[]> {
  const servers = (await loadServers()).filter(s => s.id !== id)
  await persistServers(servers)
  return servers
}

/** Mask one server for the wire (no secrets ever leave the host). */
export function maskServer(server: RemoteServer): RemoteServerSafe {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    hasPassword: server.password !== undefined && server.password !== '',
    hasPassphrase: server.passphrase !== undefined && server.passphrase !== '',
    ...(server.privateKeyPath !== undefined ? { privateKeyPath: server.privateKeyPath } : {}),
    ...(server.rootPath !== undefined ? { rootPath: server.rootPath } : {}),
  }
}
