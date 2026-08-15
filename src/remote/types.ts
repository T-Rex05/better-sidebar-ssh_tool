/**
 * Remote SSH feature shapes (HOST side only). The client declares its own
 * wire mirrors in src/client/api.ts so this node-typed module never leaks
 * into the browser declaration graph (see tests/api-surface.spec.ts).
 */

/** Authentication method of one server entry. */
export type RemoteAuthType = 'password' | 'privateKey'

/** One configured server (persisted to the host-side config file). */
export interface RemoteServer {
  /** Stable id (uuid) minted on creation. */
  id: string
  /** Display name (user-facing). */
  name: string
  /** Hostname or IP literal. */
  host: string
  /** SSH port (1-65535). */
  port: number
  /** Login username. */
  username: string
  /** Authentication method. */
  authType: RemoteAuthType
  /**
   * Plaintext password (authType 'password'). Stored in the host-side
   * config file (chmod 0600 on POSIX) — same local-machine tradeoff as the
   * dsh-ssh plugin's dsh-ssh.json. NEVER returned to the browser: the list
   * endpoint masks it into hasPassword.
   */
  password?: string
  /**
   * Absolute HOST-side path of the private key file (authType 'privateKey').
   * The key bytes are read at connect time, never stored.
   */
  privateKeyPath?: string
  /** Optional passphrase of the private key (masked like the password). */
  passphrase?: string
  /**
   * The remote directory the explorer opens. Must be an absolute POSIX path
   * ('/...'); empty = the login home (resolved via realpath('.')).
   */
  rootPath?: string
}

/** Wire view of one server: secrets replaced by presence flags. */
export interface RemoteServerSafe {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: RemoteAuthType
  hasPassword: boolean
  hasPassphrase: boolean
  privateKeyPath?: string
  rootPath?: string
}

/** One remote directory row (mirrored by the client's RemoteFsEntry). */
export interface RemoteFsEntry {
  name: string
  /** Absolute POSIX path. */
  path: string
  isDir: boolean
  /** True for symlinks (treated as files; never followed). */
  isLink: boolean
  /** File size in bytes (0 for directories). */
  size: number
  /** POSIX-hidden (dot-prefixed) entry, dimmed by the client. */
  hidden: boolean
}

/** One listed remote level. */
export interface RemoteFsListing {
  path: string
  entries: RemoteFsEntry[]
  /** True when the level exceeded the row bound. */
  truncated: boolean
}

/** Text/binary read result of one remote file. */
export type RemoteFileRead =
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'binary'; size: number; truncated: boolean; head: string }
