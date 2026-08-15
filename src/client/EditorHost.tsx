/**
 * The editor tab host: resolves a file's previewer through the sidebar
 * registry (`matchFileViewer`), fetches bytes per the matched viewer's
 * fetch strategy, and renders its component — or the shared download pane
 * when nothing can render the file. The header shows the file title; the
 * editable code/markdown viewers render their own toolbar below it.
 *
 * The strategy dispatch is pure (planFirstMatch / planFsReadOutcome in
 * editor-load.ts); this component only wires it to the host APIs.
 */
import { useEffect, useState } from 'react'
import { createElement } from 'react'
import type { Context } from '../context-types.ts'
import { api, mediaUrl, type SessionScope } from './api.ts'
import { BinaryDownload } from './binary-download.tsx'
import { planFirstMatch, planFsReadOutcome, type EditorLoadAction } from './editor-load.ts'
import { t } from './locales.ts'
import type { FileViewerDescriptor } from './service.ts'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown }
  | { status: 'binary' }

export function EditorHost(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  /** Present on remote files: routes reads/writes through the remote API. */
  remote?: { serverId: string; serverName: string }
}) {
  const { ctx, store, scope, path, title, remote } = props
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    // Aborts the matched viewer's `load` when the editor tears down (tab
    // closed, path changed, session switched) or re-matches the viewer.
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    const mediaUrlOf = (): string => mediaUrl(scope, path)
    // Remote files load through the SFTP API: only fsRead-strategy viewers
    // (code/markdown/html) can render them — image/pdf/office degrade to a
    // remote download. The write-back hook pushes edits to the server.
    if (remote !== undefined) {
      api.remoteFsRead(remote.serverId, path).then((result) => {
        if (cancelled) return
        if (result.kind === 'binary') {
          setLoad({ status: 'binary' })
          return
        }
        const viewer = ctx.betterSidebar?.matchFileViewer(path)
        if (viewer === undefined || viewer.fetchStrategy !== 'fsRead') {
          setLoad({ status: 'binary' })
          return
        }
        setLoad({ status: 'ready', viewer, content: result.content, truncated: result.truncated })
      }).catch((error: unknown) => {
        if (cancelled) return
        setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
      return () => { cancelled = true; controller.abort() }
    }
    const apply = (action: EditorLoadAction): void => {
      if (cancelled) return
      switch (action.kind) {
        case 'binary':
          setLoad({ status: 'binary' })
          return
        case 'render':
          setLoad({
            status: 'ready',
            viewer: action.viewer,
            content: action.content,
            truncated: action.truncated,
            mediaUrl: action.mediaUrl,
            customData: action.customData,
          })
          return
        case 'customLoad':
          void action.viewer.load?.(path, scope, controller.signal).then((data) => {
            if (cancelled) return
            setLoad({ status: 'ready', viewer: action.viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
        case 'fetchFsRead':
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            // Binary reads carry the head bytes for the detect re-match.
            const outcome = planFsReadOutcome(action.viewer, {
              binary: result.kind === 'binary',
              content: result.kind === 'text' ? result.content : '',
              truncated: result.truncated,
              head: result.kind === 'binary' ? result.head : undefined,
            }, (head) => ctx.betterSidebar?.matchFileViewer(path, head), mediaUrlOf)
            apply(outcome)
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
      }
    }
    apply(planFirstMatch(ctx.betterSidebar?.matchFileViewer(path), mediaUrlOf))
    return () => { cancelled = true; controller.abort() }
  }, [scope.sessionId, scope.cwd, path, ctx, remote?.serverId])

  // The remote write-back hook: the viewer's save/sync button pushes edits
  // to the server (the sync button). Local files keep the viewer's default.
  const writeFile = remote === undefined
    ? undefined
    : (content: string): Promise<unknown> => api.remoteFsWrite(remote.serverId, path, content)

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle} title={path}>{title}</span>
        {remote !== undefined && <span className={css.remoteEditorBadge}>{remote.serverName}</span>}
      </div>
      {load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
      {load.status === 'error' && <div className={css.editorError}>{load.message}</div>}
      {load.status === 'binary' && <BinaryDownload scope={scope} path={path} remote={remote} />}
      {load.status === 'ready' && createElement(load.viewer.component, {
        ctx, store, scope, path, title,
        viewerId: load.viewer.id,
        content: load.content,
        truncated: load.truncated,
        mediaUrl: load.mediaUrl,
        customData: load.customData,
        writeFile,
        remote: remote !== undefined,
      })}
    </div>
  )
}
