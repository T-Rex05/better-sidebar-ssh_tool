/**
 * The remote (SSH) explorer: TWO PANES — a narrow server list on the left
 * and the selected server's directory view on the right. Selecting a server
 * opens its ROOT ONLY (a single listing, PyCharm-like navigation); clicking
 * a folder enters it; the breadcrumb bar above the listing navigates back:
 * [⇤ list] [server ▾] / seg / seg [↑ up]. Files open the shared editor with
 * tab.meta.remote set; the row context menu offers rename / delete / copy
 * path / Start SSH Session in Directory (folders) / edit server (server
 * rows).
 *
 * Performance: listings are cached in-memory (instant revisit) and in
 * localStorage (fresh entries render immediately, stale ones refresh in the
 * background), and the first PREFETCH_DIRS subfolders of the CURRENT
 * directory load in the background so entering one is usually instant. The
 * root listing is keyed BOTH by the bare serverId (the connect response
 * arrives keyless) and by its real path, so the directory pane always finds
 * its data.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCheckOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconCodeOutline16, IconCopyOutline16,
  IconFolderClose16, IconRefreshOutline16, IconTrashOutline16, Input, Menu, Modal, Button, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type RemoteFsEntry, type RemoteFsListing, type RemoteServerSafe, type SessionScope } from './api.ts'
import type { Context } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import { getRemoteTerminalManager } from './remote-terminal-shared.tsx'
import { IconServerOutline16 } from './icons.tsx'
import { RemoteServerForm } from './RemoteServerForm.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** How many subfolders to prefetch after listing one directory. */
const PREFETCH_DIRS = 8
/** Folders beyond this count skip prefetching (big listings). */
const PREFETCH_PARENT_MAX = 80

/** localStorage cache of loaded levels (key → entries + timestamp). */
const DISK_CACHE_KEY = 'dsh-sidebar-remote-cache:v1'
/** A cached level is served directly while younger than this; older ones
 *  render instantly and refresh in the background. */
const DISK_CACHE_TTL_MS = 60_000
/** Cache size guard: levels beyond this are dropped wholesale. */
const DISK_CACHE_MAX_LEVELS = 300

interface LevelData {
  entries?: RemoteFsEntry[]
  error?: string
  loading?: boolean
  /** The real path of the listing (root fetches know it only post-response). */
  path?: string
}

interface ServerConn {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  error?: string
  root?: string
}

/** The directory currently shown (single-level navigation). */
interface CurrentDir {
  serverId: string
  /** The absolute path being listed. */
  path: string
  /** The server's root (breadcrumb base). */
  root: string
}

interface RowMenuState {
  serverId: string
  serverName: string
  path: string
  isDir: boolean
  x: number
  y: number
}

interface DiskLevel {
  at: number
  path?: string
  entries: RemoteFsEntry[]
}

interface DiskCacheDoc {
  levels: Record<string, DiskLevel>
}

/** The level key of one directory (serverId for the root row). */
function levelKey(serverId: string, path: string): string {
  return serverId + '|' + path
}

/** Last path segment. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const at = trimmed.lastIndexOf('/')
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** Format a byte count for the row title. */
function formatSize(size: number): string {
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / 1024 / 1024).toFixed(1) + ' MB'
}

/** Read the persisted level cache (corrupt/missing → empty). */
function readDiskCache(): Record<string, DiskLevel> {
  try {
    const raw = localStorage.getItem(DISK_CACHE_KEY)
    if (raw === null) return {}
    const doc = JSON.parse(raw) as Partial<DiskCacheDoc>
    if (doc.levels === null || typeof doc.levels !== 'object') return {}
    return doc.levels as Record<string, DiskLevel>
  } catch {
    return {}
  }
}

/** Write one level into the persisted cache (best-effort, size-guarded). */
function writeDiskLevel(key: string, level: DiskLevel): void {
  try {
    const doc: DiskCacheDoc = { levels: { ...readDiskCache() } }
    if (Object.keys(doc.levels).length >= DISK_CACHE_MAX_LEVELS) doc.levels = {}
    doc.levels[key] = level
    localStorage.setItem(DISK_CACHE_KEY, JSON.stringify(doc))
  } catch {
    // Quota/JSON failure: the cache is best-effort, never fatal.
  }
}

/** The breadcrumb segments of one directory, relative to its root. */
function segmentsOf(current: CurrentDir): string[] {
  let rel = current.path
  if (current.root !== '' && current.root !== '/' && current.path.startsWith(current.root)) {
    rel = current.path.slice(current.root.length)
  }
  return rel.split('/').filter(segment => segment !== '')
}

export function RemoteExplorer(props: { ctx: Context; store: SidebarStore; scope: SessionScope }) {
  const { ctx, store, scope } = props
  const [servers, setServers] = useState<RemoteServerSafe[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connections, setConnections] = useState<Record<string, ServerConn>>({})
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [selected, setSelected] = useState<string | null>(null)
  const [current, setCurrent] = useState<CurrentDir | null>(null)
  const [serverMenuOpen, setServerMenuOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)
  const [renaming, setRenaming] = useState<{ serverId: string; path: string; name: string } | null>(null)
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [deleting, setDeleting] = useState<{ serverId: string; path: string; name: string; isDir: boolean } | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [formServer, setFormServer] = useState<RemoteServerSafe | 'new' | null>(null)

  const storeLevel = useCallback((key: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [key]: level }
    setData(dataRef.current)
  }, [])

  const refreshServers = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      const result = await api.remoteServers()
      setServers(result.servers)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => { void refreshServers() }, [refreshServers])

  /** One network round trip; stores (and persists) the result under BOTH
   *  keys for a root fetch (bare serverId + the real path). */
  const fetchRemote = useCallback(async (
    serverId: string,
    path: string | undefined,
    key: string,
  ): Promise<RemoteFsListing | undefined> => {
    try {
      const listing = await api.remoteFsTree(serverId, path)
      storeLevel(key, { path: listing.path, entries: listing.entries })
      writeDiskLevel(key, { at: Date.now(), path: listing.path, entries: listing.entries })
      if (path === undefined && listing.path !== '') {
        const rootKey = levelKey(serverId, listing.path)
        storeLevel(rootKey, { path: listing.path, entries: listing.entries })
        writeDiskLevel(rootKey, { at: Date.now(), path: listing.path, entries: listing.entries })
      }
      setConnections(prev => ({ ...prev, [serverId]: { status: 'connected', root: listing.path } }))
      return listing
    } catch (error: unknown) {
      // A refresh failure keeps the displayed listing; a first-load failure
      // shows the error row.
      if (dataRef.current[key]?.entries === undefined) {
        storeLevel(key, { error: error instanceof Error ? error.message : String(error) })
      }
      setConnections(prev => ({
        ...prev,
        [serverId]: { status: 'error', error: error instanceof Error ? error.message : String(error) },
      }))
      return undefined
    }
  }, [storeLevel])

  /**
   * Load one remote directory (root when path is undefined). Resolution:
   * in-memory (instant) → persisted cache (instant; stale ones refresh in
   * the background) → network with a loading row. `force` always hits the
   * network but keeps whatever is displayed until the fresh listing lands.
   * Returns the (possibly cached) listing with its REAL path, or undefined
   * on failure.
   */
  const loadDir = useCallback(async (
    serverId: string,
    path: string | undefined,
    opts?: { force?: boolean; prefetch?: boolean },
  ): Promise<RemoteFsListing | undefined> => {
    const key = path === undefined ? serverId : levelKey(serverId, path)
    const force = opts?.force === true
    const cur = dataRef.current[key]
    if (cur?.entries !== undefined && !force) {
      return { path: cur.path ?? path ?? '', entries: cur.entries, truncated: false }
    }
    if (cur?.entries === undefined) {
      const disk = force ? undefined : readDiskCache()[key]
      if (disk !== undefined && disk.path !== undefined) {
        const fresh = Date.now() - disk.at < DISK_CACHE_TTL_MS
        storeLevel(key, { path: disk.path, entries: disk.entries })
        if (fresh) {
          // The ROOT is served instantly from cache and revalidated in the
          // background (so the connection state stays live); subdirectories
          // are served without any round trip.
          if (path === undefined) void fetchRemote(serverId, path, key)
          return { path: disk.path, entries: disk.entries, truncated: false }
        }
        // Stale: the cached listing stays on screen while refreshing below.
      } else {
        storeLevel(key, { loading: true })
      }
    }
    return fetchRemote(serverId, path, key)
  }, [fetchRemote, storeLevel])

  /** Prefetch the first subfolders of a listing (background cache only). */
  const prefetch = useCallback((serverId: string, listing: RemoteFsListing): void => {
    if (listing.entries.length > PREFETCH_PARENT_MAX) return
    for (const entry of listing.entries.filter(e => e.isDir).slice(0, PREFETCH_DIRS)) {
      void loadDir(serverId, entry.path, { prefetch: true })
    }
  }, [loadDir])

  /** Select a server: connect and open ITS ROOT ONLY. */
  const selectServer = useCallback((server: RemoteServerSafe): void => {
    setSelected(server.id)
    setCurrent(null)
    setConnections(prev => ({ ...prev, [server.id]: { status: 'connecting' } }))
    void loadDir(server.id, undefined).then(listing => {
      if (listing !== undefined) {
        setCurrent({ serverId: server.id, path: listing.path, root: listing.path })
        prefetch(server.id, listing)
      }
    })
  }, [loadDir, prefetch])

  /** Enter one folder (replace the listing). */
  const enterDir = useCallback((serverId: string, dirPath: string, root: string): void => {
    setCurrent({ serverId, path: dirPath, root })
    void loadDir(serverId, dirPath).then(listing => {
      if (listing !== undefined) prefetch(serverId, listing)
    })
  }, [loadDir, prefetch])

  /** Jump the breadcrumb to one level (list that directory). */
  const jumpTo = useCallback((segments: string[]): void => {
    if (current === null) return
    const base = current.root.replace(/\/+$/, '')
    const path = segments.length === 0 ? current.root : base + '/' + segments.join('/')
    enterDir(current.serverId, path, current.root)
  }, [current, enterDir])

  /** Up one level. */
  const upOne = useCallback((): void => {
    if (current === null) return
    jumpTo(segmentsOf(current).slice(0, -1))
  }, [current, jumpTo])

  /** Refresh the CURRENT directory (and the server list) in place. */
  const refreshAll = useCallback((): void => {
    void refreshServers()
    if (current !== null) void loadDir(current.serverId, current.path, { force: true })
  }, [refreshServers, current, loadDir])

  /** Open a remote file in the shared editor (tab.meta.remote routes IO). */
  const openFile = useCallback((serverId: string, serverName: string, path: string): void => {
    ctx.betterSidebar?.openTab({
      type: 'editor',
      title: baseName(path),
      path,
      id: 'editor:remote:' + serverId + ':' + path,
      meta: { remote: { serverId, serverName } },
    })
  }, [ctx])

  /** Start SSH Session in Directory: open a new remote terminal. */
  const startSession = useCallback((serverId: string, serverName: string, dir: string): void => {
    const manager = getRemoteTerminalManager()
    if (manager !== null) {
      manager.openRemoteTerminal(scope, { serverId, serverName, dir })
      return
    }
    ctx.betterSidebar?.openTab({
      type: 'remote-terminal',
      meta: { serverId, serverName, dir },
    }, scope)
  }, [ctx, scope])

  /** Reload the parent of a path after rename/delete. */
  const reloadParent = useCallback((serverId: string, path: string): void => {
    const at = path.lastIndexOf('/')
    const parent = at <= 0 ? '/' : path.slice(0, at)
    if (current !== null && current.serverId === serverId) {
      void loadDir(serverId, parent, { force: true })
      setCurrent(prev => (prev === null ? prev : { ...prev, path: parent }))
    } else {
      void loadDir(serverId, parent, { force: true })
    }
  }, [current, loadDir])

  const submitRename = useCallback(async (): Promise<void> => {
    const target = renaming
    if (target === null || renamingBusy) return
    if (target.name.trim() === '' || target.name.includes('/')) return
    setRenamingBusy(true)
    try {
      await api.remoteFsRename(target.serverId, target.path, target.name.trim())
      setRenaming(null)
      reloadParent(target.serverId, target.path)
    } finally {
      setRenamingBusy(false)
    }
  }, [renaming, renamingBusy, reloadParent])

  const submitDelete = useCallback(async (): Promise<void> => {
    const target = deleting
    if (target === null || deletingBusy) return
    setDeletingBusy(true)
    try {
      await api.remoteFsDelete(target.serverId, target.path)
      setDeleting(null)
      reloadParent(target.serverId, target.path)
    } finally {
      setDeletingBusy(false)
    }
  }, [deleting, deletingBusy, reloadParent])

  const openRowMenu = (event: MouseEvent, state: Omit<RowMenuState, 'x' | 'y'>): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ ...state, x: event.clientX, y: event.clientY })
  }

  const serverNameOf = (serverId: string): string => servers?.find(s => s.id === serverId)?.name ?? serverId

  /** The breadcrumb bar of the current directory. */
  const renderBreadcrumb = (dir: CurrentDir): ReactNode => {
    const server = servers?.find(s => s.id === dir.serverId)
    const segments = segmentsOf(dir)
    return (
      <div className={css.remoteBreadcrumb}>
        <Menu
          open={serverMenuOpen}
          onClose={() => { setServerMenuOpen(false) }}
          items={[
            ...(servers ?? []).map(candidate => ({
              id: candidate.id,
              label: candidate.name + ' (' + candidate.username + '@' + candidate.host + ')',
              ...(candidate.id === dir.serverId ? { icon: <IconCheckOutline16 size={14} /> } : {}),
            })),
            { type: 'separator' as const, id: 'sep' },
            { id: 'add', label: t('remoteAddServer'), icon: <IconServerOutline16 size={14} /> },
          ]}
          onSelect={(id) => {
            setServerMenuOpen(false)
            if (id === 'add') { setFormServer('new'); return }
            const target = servers?.find(candidate => candidate.id === id)
            if (target !== undefined) selectServer(target)
          }}
          portal
          align='start'
          anchor={(
            <button
              type='button'
              className={css.remoteCrumbServer}
              title={t('remoteSwitchServer')}
              onClick={() => { setServerMenuOpen(v => !v) }}
            >
              <IconServerOutline16 size={14} />
              <span className={css.explorerName}>{server?.name ?? dir.serverId}</span>
            </button>
          )}
        />
        {segments.map((segment, index) => (
          <span key={index} className={css.remoteCrumbSeg}>
            <span className={css.remoteCrumbSep}>/</span>
            <button
              type='button'
              className={clsx(css.remoteCrumbButton, index === segments.length - 1 && css.remoteCrumbCurrent)}
              title={'/' + segments.slice(0, index + 1).join('/')}
              onClick={() => { jumpTo(segments.slice(0, index + 1)) }}
            >
              {segment}
            </button>
          </span>
        ))}
        <span className={css.remoteCrumbSpacer} />
        <button
          type='button'
          className={css.remoteUpButton}
          title={t('remoteUp')}
          disabled={segments.length === 0}
          onClick={upOne}
        >
          <IconChevronLeftOutline14 className={css.remoteUpIcon} />
          <span>{t('remoteUp')}</span>
        </button>
      </div>
    )
  }

  /** The single-level directory listing (right pane). */
  const renderDir = (dir: CurrentDir): ReactNode => {
    const key = levelKey(dir.serverId, dir.path)
    const level = data[key]
    const serverName = serverNameOf(dir.serverId)
    let body: ReactNode
    if (level === undefined || level.loading === true) {
      body = <div className={css.explorerRow} style={{ paddingLeft: 12 }}>{t('loading')}</div>
    } else if (level.error !== undefined) {
      body = <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: 12 }}>{level.error}</div>
    } else {
      const entries = level.entries ?? []
      if (entries.length === 0) {
        body = <div className={css.explorerRow} style={{ paddingLeft: 12 }}>{t('remoteEmptyDir')}</div>
      } else {
        body = entries.map(entry => {
          if (entry.isDir) {
            return (
              <div
                key={entry.path}
                role='button'
                tabIndex={0}
                className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
                style={{ paddingLeft: 12 }}
                onClick={() => { enterDir(dir.serverId, entry.path, dir.root) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); enterDir(dir.serverId, entry.path, dir.root) }
                }}
                onContextMenu={(event) => { openRowMenu(event, { serverId: dir.serverId, serverName, path: entry.path, isDir: true }) }}
              >
                <IconFolderClose16 size={14} />
                <span className={css.explorerName}>{entry.name}</span>
                <IconChevronRightOutline14 className={css.remoteEnterHint} />
              </div>
            )
          }
          return (
            <div
              key={entry.path}
              role='button'
              tabIndex={0}
              className={clsx(css.explorerRow, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: 12 }}
              title={entry.path + (entry.size > 0 ? ' · ' + formatSize(entry.size) : '')}
              onClick={() => { openFile(dir.serverId, serverName, entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFile(dir.serverId, serverName, entry.path) }
              }}
              onContextMenu={(event) => { openRowMenu(event, { serverId: dir.serverId, serverName, path: entry.path, isDir: false }) }}
            >
              <IconCodeOutline16 size={14} />
              <span className={css.explorerName}>{entry.name}</span>
            </div>
          )
        })
      }
    }
    return <div className={css.remoteDirList}>{body}</div>
  }

  /** One compact server row in the LEFT pane. */
  const renderServer = (server: RemoteServerSafe): ReactNode => {
    const conn = connections[server.id] ?? { status: 'idle' }
    const isSelected = selected === server.id
    return (
      <div
        key={server.id}
        role='button'
        tabIndex={0}
        className={clsx(css.remoteServerRow, isSelected && css.remoteServerSelected)}
        onClick={() => { selectServer(server) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectServer(server) }
        }}
        onContextMenu={(event) => { openRowMenu(event, { serverId: server.id, serverName: server.name, path: conn.root ?? '', isDir: true }) }}
      >
        <span className={clsx(css.remoteStatus, css['remoteStatus' + conn.status.charAt(0).toUpperCase() + conn.status.slice(1)])} />
        <span className={css.explorerName}>{server.name}</span>
        <span className={css.remoteServerHost}>{server.username + '@' + server.host}</span>
      </div>
    )
  }

  return (
    <div className={css.remote}>
      <div className={css.explorerHeader}>
        <span className={css.explorerRoot}>{t('remote')}</span>
        <button
          type='button'
          className={css.iconButton}
          aria-label={t('remoteAddServer')}
          title={t('remoteAddServer')}
          onClick={() => { setFormServer('new') }}
        >
          <IconServerOutline16 />
        </button>
        <button
          type='button'
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refreshAll}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      <div className={css.remoteBody}>
        {servers === null && <div className={css.explorerEmpty}>{t('loading')}</div>}
        {loadError !== null && <div className={css.explorerError}>{loadError}</div>}
        {servers !== null && servers.length === 0 && (
          <div className={css.explorerEmpty}>
            <span>{t('remoteNoServers')}</span>
            <button type='button' className={css.remoteAddButton} onClick={() => { setFormServer('new') }}>
              {t('remoteAddServer')}
            </button>
          </div>
        )}
        {servers !== null && servers.length > 0 && (
          <>
            <div className={css.remoteServerList}>
              {servers.map(renderServer)}
            </div>
            <div className={css.remoteDirPane}>
              {current === null ? (
                <div className={css.remoteDirEmpty}>{t('remoteSelectServer')}</div>
              ) : (
                <>
                  {renderBreadcrumb(current)}
                  {renderDir(current)}
                </>
              )}
            </div>
          </>
        )}
      </div>
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          ...(rowMenu?.isDir === true
            ? [{ id: 'session', label: t('remoteStartSession') }]
            : []),
          { id: 'rename', label: t('rename') },
          { id: 'delete', label: t('delete'), icon: <IconTrashOutline16 size={14} />, danger: true },
          { type: 'separator' as const, id: 'sep' },
          { id: 'copy', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
          ...(rowMenu?.path === '' || rowMenu?.path === undefined
            ? [{ type: 'separator' as const, id: 'sep2' }, { id: 'edit-server', label: t('remoteEditServer'), icon: <IconServerOutline16 size={14} /> }]
            : []),
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'edit-server') {
            const server = servers?.find(s => s.id === target.serverId)
            if (server !== undefined) setFormServer(server)
            return
          }
          if (id === 'session') {
            startSession(target.serverId, target.serverName, target.path)
            return
          }
          if (id === 'copy') {
            void writeClipboard(target.path)
            return
          }
          if (id === 'rename') {
            setRenaming({ serverId: target.serverId, path: target.path, name: baseName(target.path) })
            return
          }
          if (id === 'delete') {
            setDeleting({ serverId: target.serverId, path: target.path, name: baseName(target.path), isDir: target.isDir })
          }
        }}
        portal
        align='start'
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
      <Modal
        open={renaming !== null}
        onClose={() => { setRenaming(null) }}
        title={t('rename')}
        closeLabel={t('cancel')}
        footer={(<Button variant='primary' disabled={renamingBusy || (renaming?.name ?? '').trim() === '' || (renaming?.name ?? '').includes('/')} onClick={() => { void submitRename() }}>{t('rename')}</Button>)}
      >
        <Input
          autoFocus
          value={renaming?.name ?? ''}
          onChange={(event) => { setRenaming(prev => (prev === null ? prev : { ...prev, name: event.target.value })) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void submitRename() }}
        />
      </Modal>
      <Modal
        open={deleting !== null}
        onClose={() => { setDeleting(null) }}
        title={t('delete')}
        closeLabel={t('cancel')}
        footer={(<Button variant='primary' disabled={deletingBusy} onClick={() => { void submitDelete() }}>{t('delete')}</Button>)}
      >
        <p className={css.gitConfirmDesc}>{deleting?.isDir === true ? t('remoteDeleteDirDesc', { path: deleting?.path ?? '' }) : t('remoteDeleteFileDesc', { path: deleting?.path ?? '' })}</p>
      </Modal>
      {formServer !== null && (
        <RemoteServerForm
          server={formServer === 'new' ? undefined : formServer}
          onClose={() => { setFormServer(null) }}
          onSaved={() => { setFormServer(null); void refreshServers() }}
        />
      )}
    </div>
  )
}
