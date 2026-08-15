/**
 * Shared bits of the remote terminal feature that stay in the CORE client
 * bundle: the wire meta shape, the view props contract, and the dock
 * toolbar (its buttons route through the terminal manager singleton — the
 * manager registers itself at client apply). The xterm view itself lives in
 * src/client/RemoteTerminalView.tsx, exported through the terminal chunk.
 */
import type { ReactNode } from 'react'
import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import type { SidebarStore } from './state.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import { IconUndockOutline16 } from './icons.tsx'

/** Identity of one remote terminal instance (tab.meta and view props). */
export interface RemoteTerminalMeta {
  serverId: string
  serverName: string
  dir: string
}

/** Props of the remote terminal view (rendered from the terminal chunk). */
export interface RemoteTerminalProps {
  scope: SessionScope
  store: SidebarStore
  tabId: string
  meta: RemoteTerminalMeta
  /** Extra toolbar row (the dock passes the undock button). */
  toolbar?: ReactNode
}

/** Manager face the shared UI uses (the full class lives in
 *  remote-terminal-manager.ts to avoid an import cycle). */
export interface RemoteTerminalManagerFace {
  /** Open one terminal: mint the id and register the view-ring tab. */
  openRemoteTerminal: (scope: SessionScope, meta: RemoteTerminalMeta) => void
  /** Move a terminal from the view ring into the center dock (chat split). */
  dockTerminal: (sessionId: string, tabId: string) => void
  /** Move a docked terminal back to the center view ring (shell survives). */
  undockTerminal: (sessionId: string, tabId: string) => void
  /** Kill one terminal (shell + tab + view-ring entry). */
  closeTerminal: (sessionId: string, tabId: string) => void
  /** Dock the latest terminal, or collapse the dock when one is docked. */
  toggleDock: (sessionId: string) => void
  /** Whether the session has any remote terminal. */
  hasTerminals: (sessionId: string) => boolean
}

/** Last path segment of a remote dir (tab labels: '/a/b' → 'b'). */
export function remoteDirLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '/') return '/'
  const at = trimmed.lastIndexOf('/')
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** Module-level manager handle (set once at client apply; HMR-safe). */
let managerRef: RemoteTerminalManagerFace | null = null

export function setRemoteTerminalManager(manager: RemoteTerminalManagerFace | null): void {
  managerRef = manager
}

export function getRemoteTerminalManager(): RemoteTerminalManagerFace | null {
  return managerRef
}

/** The docked terminal's toolbar: undock (back to the view ring) + close. */
export function RemoteTerminalToolbar(props: { tabId: string; sessionId: string }) {
  const { tabId, sessionId } = props
  return (
    <div className={css.remoteTerminalToolbarInner}>
      <button
        type="button"
        className={css.iconButton}
        title={t('remoteUndock')}
        aria-label={t('remoteUndock')}
        onClick={() => { managerRef?.undockTerminal(sessionId, tabId) }}
      >
        <IconUndockOutline16 />
      </button>
      <button
        type="button"
        className={css.iconButton}
        title={t('close')}
        aria-label={t('close')}
        onClick={() => { managerRef?.closeTerminal(sessionId, tabId) }}
      >
        <IconCloseFill14 />
      </button>
    </div>
  )
}
