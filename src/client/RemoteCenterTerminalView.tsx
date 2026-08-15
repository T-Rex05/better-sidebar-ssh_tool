/**
 * The center (conversation.view) surface of one remote terminal: the tab
 * next to 对话/轨迹. The header carries 分栏 (move into the center dock,
 * which switches the center back to the chat view) and 关闭 (kill).
 * The xterm body loads lazily from the terminal chunk.
 */
import type { ComponentType } from 'react'
import type { SessionScope } from './api.ts'
import type { RemoteTerminalRecord, SidebarStore } from './state.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { remoteDirLabel, type RemoteTerminalManagerFace, type RemoteTerminalProps } from './remote-terminal-shared.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Module-level-stable picker for the chunk-resident remote terminal view. */
function pickRemoteTerminal(mod: Record<string, unknown>): ComponentType<RemoteTerminalProps> | undefined {
  return mod.RemoteTerminalView as ComponentType<RemoteTerminalProps> | undefined
}

const LazyRemoteTerminal = lazyChunkComponent<RemoteTerminalProps>('terminal', pickRemoteTerminal)

export function RemoteCenterTerminalView(props: {
  sessionId: string
  record: RemoteTerminalRecord
  store: SidebarStore
  manager: RemoteTerminalManagerFace
}) {
  const { sessionId, record, store, manager } = props
  const scope: SessionScope = { sessionId }
  return (
    <div className={css.remoteCenter}>
      <div className={css.remoteCenterHeader}>
        <span className={css.remoteCenterTitle} title={record.dir}>
          {record.serverName + ': ' + remoteDirLabel(record.dir)}
        </span>
        <div className={css.remoteCenterActions}>
          <button
            type="button"
            className={css.remoteCenterButton}
            onClick={() => { manager.dockTerminal(sessionId, record.tabId) }}
          >
            {t('remoteDock')}
          </button>
          <button
            type="button"
            className={css.remoteCenterButton}
            onClick={() => { manager.closeTerminal(sessionId, record.tabId) }}
          >
            {t('close')}
          </button>
        </div>
      </div>
      <LazyRemoteTerminal
        scope={scope}
        store={store}
        tabId={record.tabId}
        meta={{ serverId: record.serverId, serverName: record.serverName, dir: record.dir }}
      />
    </div>
  )
}
