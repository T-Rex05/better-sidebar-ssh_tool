/**
 * The remote terminal view: the same xterm surface as the local terminal
 * but attached to /sidebar/ws/remote-terminal (ssh2 pty shell). Exported
 * through the terminal chunk (see src/client/chunks/terminal.tsx); this
 * module must never be imported by the core bundle — it carries xterm.
 */
import { TerminalView } from './TerminalView.tsx'
import type { RemoteTerminalProps } from './remote-terminal-shared.tsx'

export function RemoteTerminalView(props: RemoteTerminalProps) {
  const { scope, store, tabId, meta, toolbar } = props
  const wsUrl = (): string => {
    const url = new URL('/sidebar/ws/remote-terminal', location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({
      sessionId: scope.sessionId,
      serverId: meta.serverId,
      tabId,
    })
    if (meta.dir !== '') params.set('dir', meta.dir)
    url.search = params.toString()
    return url.toString()
  }
  return (
    <TerminalView
      scope={scope}
      store={store}
      tabId={tabId}
      wsUrl={wsUrl}
      toolbar={toolbar}
      ownLifetime
      attachKey={meta.serverId + '|' + meta.dir}
    />
  )
}
