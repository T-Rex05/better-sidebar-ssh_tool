/**
 * OpenSSH config support (HOST side): parse ~/.ssh/config into server
 * entries for the remote explorer.
 *
 * The parser is deliberately minimal — it covers the fields the explorer
 * actually uses (HostName / User / Port / IdentityFile) plus ProxyJump
 * detection (entries behind a jump host are SKIPPED on import: ssh2 has no
 * native ProxyJump, and silently importing them would produce servers that
 * cannot connect). `Host *` blocks are treated as defaults: their fields
 * apply to every concrete alias that does not override them (the FIRST
 * matching block wins, matching OpenSSH's own semantics closely enough).
 * Imported servers always authenticate by KEY — the entry's IdentityFile
 * or the standard ~/.ssh default key; entries with neither are skipped.
 */
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadServers, persistServers, resolveDefaultKeyPath } from './config-store.ts'
import type { RemoteServer } from './types.ts'

/** One parsed Host block of an OpenSSH config. */
export interface SshConfigEntry {
  /** The Host alias (concrete names only; wildcards stay in `defaults`). */
  host: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  /** Present when the entry sits behind a jump host (unsupported → skipped). */
  proxyJump?: string
}

const KEYWORDS = new Set(['host', 'hostname', 'user', 'port', 'identityfile', 'proxyjump'])

/** Parse one config document into concrete entries (wildcard blocks → defaults). */
export function parseSshConfig(text: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = []
  let currentHosts: string[] = []
  let current: Partial<SshConfigEntry> = {}
  // Fields of the FIRST `Host *` block; concrete aliases inherit them.
  let defaults: Partial<SshConfigEntry> = {}

  const flush = (): void => {
    if (currentHosts.length === 0) return
    if (currentHosts.includes('*')) {
      // The first wildcard block seeds the defaults for later aliases
      // (OpenSSH: the first matching block wins).
      if (Object.keys(defaults).length === 0) defaults = { ...current }
      currentHosts = []
      current = {}
      return
    }
    const hostName = current.hostName ?? defaults.hostName
    const user = current.user ?? defaults.user
    const port = current.port ?? defaults.port
    const identityFile = current.identityFile ?? defaults.identityFile
    for (const host of currentHosts) {
      if (/[*?]/.test(host)) continue // wildcard alias: not importable
      entries.push({
        host,
        ...(hostName !== undefined ? { hostName } : {}),
        ...(user !== undefined ? { user } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(identityFile !== undefined ? { identityFile } : {}),
        ...(current.proxyJump !== undefined ? { proxyJump: current.proxyJump } : {}),
      })
    }
    currentHosts = []
    current = {}
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (line === '' || line.startsWith('#')) continue
    const space = line.search(/\s/)
    const keyword = (space === -1 ? line : line.slice(0, space)).toLowerCase()
    const value = space === -1 ? '' : line.slice(space + 1).trim()
    if (!KEYWORDS.has(keyword) || value === '') continue
    switch (keyword) {
      case 'host':
        flush()
        currentHosts = value.split(/\s+/)
        break
      case 'hostname':
        current.hostName = value
        break
      case 'user':
        current.user = value
        break
      case 'port': {
        const port = Number(value)
        if (Number.isInteger(port) && port >= 1 && port <= 65535) current.port = port
        break
      }
      case 'identityfile':
        // Multiple IdentityFile lines: the first wins (OpenSSH tries each;
        // the explorer stores one key per server).
        current.identityFile ??= value
        break
      case 'proxyjump':
        current.proxyJump = value
        break
    }
  }
  flush()
  return entries
}

/** The path of the user's OpenSSH config (missing → undefined). */
export function sshConfigPath(): string | undefined {
  const explicit = process.env.SSH_CONFIG
  if (explicit !== undefined && explicit !== '') return explicit
  return join(homedir(), '.ssh', 'config')
}

/** Expand a leading `~`/`$HOME` in a path. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home !== undefined && path.startsWith('$HOME/')) return join(home, path.slice(6))
  return path
}

/**
 * Import ~/.ssh/config into the server list. Entries are skipped when a
 * server with the same NAME already exists or when the entry sits behind a
 * ProxyJump (ssh2 has no native jump-host support). Authentication is
 * ALWAYS key-based: the entry's IdentityFile when present, otherwise the
 * standard ~/.ssh default key (id_ed25519 → id_ecdsa → id_rsa → id_dsa);
 * an entry with neither is skipped. Persists the merged list.
 */
export async function importFromSshConfig(): Promise<{ imported: number; skipped: number; reason?: string }> {
  const configPath = sshConfigPath()
  if (configPath === undefined) return { imported: 0, skipped: 0, reason: 'no-config' }
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch {
    return { imported: 0, skipped: 0, reason: 'no-config' }
  }
  const entries = parseSshConfig(text)
  const servers = await loadServers()
  const existingNames = new Set(servers.map(server => server.name))
  const username = (() => {
    try { return userInfo().username } catch { return 'root' }
  })()
  const defaultKey = resolveDefaultKeyPath()
  let imported = 0
  let skipped = 0
  for (const entry of entries) {
    if (existingNames.has(entry.host) || entry.proxyJump !== undefined) {
      skipped += 1
      continue
    }
    const keyPath = entry.identityFile !== undefined ? expandHome(entry.identityFile) : defaultKey
    if (keyPath === undefined) {
      skipped += 1 // no IdentityFile AND no default key: nothing to authenticate with
      continue
    }
    servers.push({
      id: randomUUID(),
      name: entry.host,
      host: entry.hostName ?? entry.host,
      port: entry.port ?? 22,
      username: entry.user ?? username,
      authType: 'privateKey',
      privateKeyPath: keyPath,
    })
    existingNames.add(entry.host)
    imported += 1
  }
  if (imported > 0) await persistServers(servers)
  return { imported, skipped, reason: skipped > 0 ? 'skipped-proxy-or-duplicate' : undefined }
}
