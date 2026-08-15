/**
 * The "no preview — download instead" pane: shown by the editor host when no
 * viewer can render a file (binary without a registered renderer, or the
 * `binary-download` strategy) and registered as the `binary-download` viewer
 * component so the declarative route and the host fallback share one UI.
 */
import type { ReactNode } from 'react'
import type { SessionScope } from './api.ts'
import { downloadUrl, remoteFileUrl } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function BinaryDownload(props: {
  scope: SessionScope
  path: string
  /** Present on remote files: the download streams from the server. */
  remote?: { serverId: string; serverName: string }
}): ReactNode {
  const { scope, path, remote } = props
  const href = remote === undefined
    ? downloadUrl(scope, path)
    : remoteFileUrl(remote.serverId, path, true)
  return (
    <div className={css.editorBinary}>
      <span className={css.editorBinaryNotice}>{t('binaryNoPreview')}</span>
      <a className={css.editorDownloadLink} href={href} download>
        {remote === undefined ? t('downloadToView') : t('remoteDownload')}
      </a>
    </div>
  )
}
