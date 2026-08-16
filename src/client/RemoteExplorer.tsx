/**
 * The remote (SSH) explorer: a server list + per-server lazy directory
 * tree. Selecting a server connects the SFTP pool and auto-expands its
 * root (rootPath, or the login home). Files open the shared editor with
 * tab.meta.remote set (EditorHost routes reads/writes through the remote
 * API); the row context menu offers rename / delete / copy path /
 * Start SSH Session in Directory (directories).
 *
 * Navigation: the selected server shows a breadcrumb bar above its tree —
 * [⇤ server list] [server ▾] / seg / seg — every segment jumps back to
 * that level (collapsing everything below), the server name opens the
 * switch-server menu, and the trailing ↑ button goes up one level.
 *
 * Performance: levels are cached THREE ways — in-memory (per mount,
 * instant revisit), localStorage (survives reloads; fresh entries render
 * immediately and stale ones refresh in the background), and prefetch
 * (the first PREFETCH_DIRS subdirectories load in the background when a
 * directory is listed, so drilling down usually hits the cache).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCheckOutline16, IconChevronLeftOutline14, IconCodeOutline16, IconCopyOutline16, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline16, IconTrashOutline16, Input, Menu, Modal, Button, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type RemoteFsEntry, type RemoteServerSafe, type SessionScope } from './api.ts'
import type { Context } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import { toggleRemoteExpanded } from './state.ts'
import { getRemoteTerminalManager } from './remote-terminal-shared.tsx'
import { IconServerOutline16 } from './icons.tsx'
import { RemoteServerForm } from './RemoteServerForm.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** How many subdirectories to prefetch after listing one level. */
const PREFETCH_DIRS = 8
/** Directories above this count skip prefetching (big listings). */
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
}

interface ServerConn {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  error?: string
  root?: string
}

interface RowMenuState {
  serverId: string
  serverName: string
  path: string
  isDir: boolean
  x: number
  y: number
}

/** One disk-cached level. */
interface DiskLevel {
  at: number
  entries: RemoteFsEntry[]
}

interface DiskCacheDoc {
  levels: Record<string, DiskLevel>
}

/** The level key of one directory (serverId for the root row). */
function levelKey(serverId: string, path: string | undefined): string {
  return path === undefined ? serverId : serverId + '|' + path
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
function writeDiskLevel(key: string, entries: RemoteFsEntry[]): void {
  try {
    const doc: DiskCacheDoc = { levels: { ...readDiskCache() } }
    if (Object.keys(doc.levels).length >= DISK_CACHE_MAX_LEVELS) doc.levels = {}
    doc.levels[key] = { at: Date.now(), entries }
    localStorage.setItem(DISK_CACHE_KEY, JSON.stringify(doc))
  } catch {
    // Quota/JSON failure: the cache is best-effort, never fatal.
  }
}

export function RemoteExplorer(props: { ctx: Context; store: SidebarStore; scope: SessionScope }) {
  const { ctx, store, scope } = props
  const [servers, setServers] = useState<RemoteServerSafe[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connections, setConnections] = useState<Record<string, ServerConn>>({})
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [selected, setSelected] = useState<string | null>(null)
  /** Breadcrumb navigation: the segments BELOW the server root. */
  const [nav, setNav] = useState<{ serverId: string; segments: string[] } | null>(null)
  const [serverMenuOpen, setServerMenuOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)
  const [renaming, setRenaming] = useState<{ serverId: string; path: string; name: string } | null>(null)
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [deleting, setDeleting] = useState<{ serverId: string; path: string; name: string; isDir: boolean } | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [formServer, setFormServer] = useState<RemoteServerSafe | 'new' | null>(null)

  const expanded = store.getSnapshot().state?.remoteExpanded ?? []

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

  /**
   * Load one remote level (root when path is undefined). Resolution order:
   * in-memory data (instant) → persisted cache (instant; background refresh
   * when stale) → network with a loading row. `force` always hits the
   * network; `prefetch` disables the recursive prefetch (one level only).
   */
  const loadLevel = useCallback((serverId: string, path: string | undefined, opts?: { force?: boolean; prefetch?: boolean }): void => {
    const key = levelKey(serverId, path)
    const current = dataRef.current[key]
    if (current !== undefined && current.entries !== undefined && opts?.force !== true) return
    if (current === undefined || opts?.force === true) {
      const disk = readDiskCache()[key]
      if (disk !== undefined && opts?.force !== true) {
        // Render the cached listing immediately; refresh in the background
        // when it is stale (or always refresh the ROOT so a reconnect sees
        // the live tree — cheap, one round trip).
        storeLevel(key, { entries: disk.entries })
        if (Date.now() - disk.at < DISK_CACHE_TTL_MS && path !== undefined) return
      } else {
        storeLevel(key, { loading: true })
      }
    }
    void fetchLevel(serverId, path, key, opts)
  }, [storeLevel])

  /** One network round trip; stores the result, persists it, prefetches. */
  const fetchLevel = useCallback(async (
    serverId: string,
    path: string | undefined,
    key: string,
    opts?: { force?: boolean; prefetch?: boolean },
  ): Promise<void> => {
    try {
      const listing = await api.remoteFsTree(serverId, path)
      storeLevel(key, { entries: listing.entries })
      writeDiskLevel(key, listing.entries)
      setConnections(prev => ({
        ...prev,
        [serverId]: { status: 'connected', root: listing.path },
      }))
      if (path === undefined && listing.path !== '') {
        storeLevel(serverId + '|' + listing.path, { entries: listing.entries })
      }
      // Prefetch the first subdirectories (one level; the user drilling
      // down then finds them cached — the whole point of "feels fast").
      if (opts?.prefetch !== true && listing.entries.length <= PREFETCH_PARENT_MAX) {
        const dirs = listing.entries.filter(entry => entry.isDir).slice(0, PREFETCH_DIRS)
        for (const dir of dirs) loadLevel(serverId, dir.path, { prefetch: true })
      }
    } catch (error: unknown) {
      storeLevel(key, { error: error instanceof Error ? error.message : String(error) })
      setConnections(prev => ({
        ...prev,
        [serverId]: { status: 'error', error: error instanceof Error ? error.message : String(error) },
      }))
    }
  }, [loadLevel, storeLevel])

  /** Select a server: connect (or re-read the cached root) and expand. */
  const selectServer = useCallback((server: RemoteServerSafe): void => {
    setSelected(server.id)
    setNav({ serverId: server.id, segments: [] })
    setConnections(prev => ({ ...prev, [server.id]: { status: 'connecting' } }))
    loadLevel(server.id, undefined)
    const snapshot = store.getSnapshot().state
    if (snapshot !== undefined && !snapshot.remoteExpanded.includes(server.id)) {
      store.reduce(s => toggleRemoteExpanded(s, server.id))
    }
  }, [loadLevel, store])

  /** Back to the server list: collapse the selected server's tree. */
  const backToServers = useCallback((): void => {
    if (selected === null) return
    store.reduce(s => ({
      ...s,
      remoteExpanded: s.remoteExpanded.filter(key => !key.startsWith(selected + '|')),
    }))
    setSelected(null)
    setNav(null)
  }, [selected, store])

  const toggleDir = useCallback((serverId: string, path: string, root: string | undefined): void => {
    const key = serverId + '|' + path
    loadLevel(serverId, path)
    store.reduce(s => toggleRemoteExpanded(s, key))
    // Breadcrumb: the path relative to the server root (root unknown →
    // the absolute path's segments; the root segment is then visible too).
    let rel = path
    if (root !== undefined && root !== '' && root !== '/' && path.startsWith(root)) {
      rel = path.slice(root.length)
    }
    const segments = rel.split('/').filter(segment => segment !== '')
    setNav({ serverId, segments })
  }, [loadLevel, store])

  /** Jump the tree to one breadcrumb level (collapse everything below). */
  const jumpTo = useCallback((serverId: string, segments: string[], root: string | undefined): void => {
    const rootPath = root ?? '/'
    const target = segments.length === 0
      ? rootPath
      : rootPath.replace(/\/+$/, '') + '/' + segments.join('/')
    // Fold every expanded key strictly below the target, keep the rest.
    store.reduce(s => {
      let next = s.remoteExpanded.filter(key => {
        if (key === serverId) return true
        if (key.startsWith(serverId + '|')) {
          const p = key.slice(serverId.length + 1)
          return !(p.startsWith(target.replace(/\/+$/, '') + '/'))
        }
        return true
      })
      // Expand the ancestor chain down to the target.
      const chain = [serverId]
      let acc = rootPath.replace(/\/+$/, '')
      for (const segment of segments) {
        acc += '/' + segment
        chain.push(serverId + '|' + acc)
      }
      for (const key of chain) {
        if (!next.includes(key)) next = [...next, key]
      }
      return { ...s, remoteExpanded: next }
    })
    // Load every level on the chain (cache hits are instant). The root row
    // itself is keyed by the bare serverId (path undefined).
    loadLevel(serverId, undefined)
    let acc = rootPath.replace(/\/+$/, '')
    for (const segment of segments) {
      acc += '/' + segment
      loadLevel(serverId, acc)
    }
    setNav({ serverId, segments })
  }, [loadLevel, store])

  /** Up one level from the current breadcrumb position. */
  const upOne = useCallback((serverId: string, segments: string[], root: string | undefined): void => {
    jumpTo(serverId, segments.slice(0, -1), root)
  }, [jumpTo])

  const refreshAll = useCallback((): void => {
    dataRef.current = {}
    setData({})
    void refreshServers()
    const snapshot = store.getSnapshot().state
    for (const key of snapshot?.remoteExpanded ?? []) {
      const at = key.indexOf('|')
      if (at === -1) loadLevel(key, undefined, { force: true })
      else loadLevel(key.slice(0, at), key.slice(at + 1), { force: true })
    }
  }, [refreshServers, loadLevel, store])

  /** Auto-load whatever the persisted session has expanded (reload case). */
  useEffect(() => {
    const snapshot = store.getSnapshot().state
    for (const key of snapshot?.remoteExpanded ?? []) {
      const at = key.indexOf('|')
      if (at === -1) loadLevel(key, undefined)
      else loadLevel(key.slice(0, at), key.slice(at + 1))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  /** Reload the parent level of a path after rename/delete. */
  const reloadParent = useCallback((serverId: string, path: string): void => {
    const at = path.lastIndexOf('/')
    if (at <= 0) loadLevel(serverId, undefined, { force: true })
    else loadLevel(serverId, path.slice(0, at), { force: true })
  }, [loadLevel])

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

  /** The breadcrumb bar of the selected server (above its tree). */
  const renderBreadcrumb = (server: RemoteServerSafe, root: string | undefined): ReactNode => {
    const segments = nav?.serverId === server.id ? nav.segments : []
    return (
      <div className={css.remoteBreadcrumb}>
        <button
          type='button'
          className={css.remoteCrumbButton}
          title={t('remoteBack')}
          aria-label={t('remoteBack')}
          onClick={backToServers}
        >
          <IconChevronLeftOutline14 />
        </button>
        <Menu
          open={serverMenuOpen}
          onClose={() => { setServerMenuOpen(false) }}
          items={[
            ...(servers ?? []).map(candidate => ({
              id: candidate.id,
              label: candidate.name + ' (' + candidate.username + '@' + candidate.host + ')',
              ...(candidate.id === server.id ? { icon: <IconCheckOutline16 size={14} /> } : {}),
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
              <span className={css.explorerName}>{server.name}</span>
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
              onClick={() => { jumpTo(server.id, segments.slice(0, index + 1), root) }}
            >
              {segment}
            </button>
          </span>
        ))}
        <span className={css.remoteCrumbSpacer} />
        <button
          type='button'
          className={css.remoteCrumbButton}
          title={t('remoteUp')}
          aria-label={t('remoteUp')}
          disabled={segments.length === 0}
          onClick={() => { upOne(server.id, segments, root) }}
        >
          <IconChevronLeftOutline14 className={css.remoteUpIcon} />
        </button>
      </div>
    )
  }

  const renderLevel = (serverId: string, path: string, root: string | undefined, depth: number): ReactNode => {
    const key = levelKey(serverId, path)
    const level = data[key]
    if (level === undefined || level.loading === true) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {level.error}
        </div>
      )
    }
    const entries = level.entries ?? []
    if (entries.length === 0) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('remoteEmptyDir')}</div>
    }
    return entries.map(entry => {
      if (entry.isDir) {
        const isOpen = expanded.includes(serverId + '|' + entry.path)
        return (
          <div key={entry.path}>
            <div
              role='button'
              tabIndex={0}
              className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: depth * 22 + 6 }}
              onClick={() => { toggleDir(serverId, entry.path, root) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleDir(serverId, entry.path, root) }
              }}
              onContextMenu={(event) => { openRowMenu(event, { serverId, serverName: serverNameOf(serverId), path: entry.path, isDir: true }) }}
            >
              {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
              <span className={css.explorerName}>{entry.name}</span>
            </div>
            {isOpen && renderLevel(serverId, entry.path, root, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          role='button'
          tabIndex={0}
          className={clsx(css.explorerRow, entry.hidden && css.explorerHidden)}
          style={{ paddingLeft: depth * 22 + 6 }}
          title={entry.path + (entry.size > 0 ? ' · ' + formatSize(entry.size) : '')}
          onClick={() => { openFile(serverId, serverNameOf(serverId), entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFile(serverId, serverNameOf(serverId), entry.path) }
          }}
          onContextMenu={(event) => { openRowMenu(event, { serverId, serverName: serverNameOf(serverId), path: entry.path, isDir: false }) }}
        >
          <IconCodeOutline16 size={14} />
          <span className={css.explorerName}>{entry.name}</span>
        </div>
      )
    })
  }

  const renderServer = (server: RemoteServerSafe): ReactNode => {
    const conn = connections[server.id] ?? { status: 'idle' }
    const isSelected = selected === server.id
    const isOpen = expanded.includes(server.id)
    return (
      <div key={server.id} className={css.remoteServer}>
        <div
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
          {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
          <span className={css.explorerName}>{server.name}</span>
          <span className={css.remoteServerHost}>{server.username + '@' + server.host}</span>
          <button
            type='button'
            className={css.iconButton}
            title={t('remoteEditServer')}
            onClick={(event) => { event.stopPropagation(); setFormServer(server) }}
          >
            <IconServerOutline16 size={14} />
          </button>
        </div>
        {conn.status === 'error' && conn.error !== undefined && (
          <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: 22 }}>
            {t('remoteConnectFailed') + ': ' + conn.error}
          </div>
        )}
        {isSelected && isOpen && renderBreadcrumb(server, conn.root)}
        {isOpen && conn.root !== undefined && (
          <div
            className={css.explorerRow}
            style={{ paddingLeft: 22 }}
            onContextMenu={(event) => { openRowMenu(event, { serverId: server.id, serverName: server.name, path: conn.root!, isDir: true }) }}
          >
            <IconFolderOpen16 size={14} />
            <span className={css.explorerName}>{baseName(conn.root)}</span>
          </div>
        )}
        {isOpen && conn.root !== undefined && renderLevel(server.id, conn.root, conn.root, 2)}
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
        {servers !== null && servers.map(renderServer)}
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
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
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
