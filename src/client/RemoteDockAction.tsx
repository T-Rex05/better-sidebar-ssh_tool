/**
 * The 分栏 action in the session header (beside the title): docks the
 * latest remote terminal of the session (chat + terminal side by side),
 * or collapses the dock when a terminal is already docked. Hidden while
 * the session has no remote terminals.
 */
import { useSyncExternalStore } from 'react'
import type { SidebarStore } from './state.ts'
import type { RemoteTerminalManagerFace } from './remote-terminal-shared.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function RemoteDockAction(props: {
  sessionId: string
  manager: RemoteTerminalManagerFace
  store: SidebarStore
}) {
  const { sessionId, manager, store } = props
  const snapshot = useSyncExternalStore(
    (callback: () => void) => store.subscribe(callback),
    () => store.getSnapshot(),
  )
  if (!manager.hasTerminals(sessionId)) return null
  const state = snapshot.state
  const anyDocked = state?.remoteTerminals.some(record => record.docked) === true
  return (
    <button
      type="button"
      className={css.remoteDockAction}
      title={anyDocked ? t('remoteUndockAll') : t('remoteDock')}
      onClick={() => { manager.toggleDock(sessionId) }}
    >
      {anyDocked ? t('remoteUndockAll') : t('remoteDock')}
    </button>
  )
}
