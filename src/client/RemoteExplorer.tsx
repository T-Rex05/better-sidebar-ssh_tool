/**
 * The remote (SSH) explorer: a server list + per-server lazy directory
 * tree. Selecting a server connects the SFTP pool and auto-expands its
 * root (rootPath, or the login home). Files open the shared editor with
 * tab.meta.remote set (EditorHost routes reads/writes through the remote
 * API); the row context menu offers rename / delete / copy path /
 * Start SSH Session in Directory (directories).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCodeOutline16, IconCopyOutline16, IconFolderClose16, IconFolderOpen16,
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

interface LevelData {
  entries?: RemoteFsEntry[]
  error?: string
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

export function RemoteExplorer(props: { ctx: Context; store: SidebarStore; scope: SessionScope }) {
  const { ctx, store, scope } = props
  const [servers, setServers] = useState<RemoteServerSafe[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connections, setConnections] = useState<Record<string, ServerConn>>({})
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [selected, setSelected] = useState<string | null>(null)
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

  /** Load one remote level (root when path is undefined). */
  const loadLevel = useCallback((serverId: string, path: string | undefined, opts?: { force?: boolean }): void => {
    const key = levelKey(serverId, path)
    if (dataRef.current[key] !== undefined && opts?.force !== true) return
    storeLevel(key, {})
    api.remoteFsTree(serverId, path).then(listing => {
      storeLevel(key, { entries: listing.entries })
      setConnections(prev => ({
        ...prev,
        [serverId]: { status: 'connected', root: listing.path },
      }))
      if (path === undefined && listing.path !== '') {
        storeLevel(serverId + '|' + listing.path, { entries: listing.entries })
      }
    }).catch((error: unknown) => {
      storeLevel(key, { error: error instanceof Error ? error.message : String(error) })
      setConnections(prev => ({
        ...prev,
        [serverId]: { status: 'error', error: error instanceof Error ? error.message : String(error) },
      }))
    })
  }, [storeLevel])

  /** Select a server: connect and auto-expand its root. */
  const selectServer = useCallback((server: RemoteServerSafe): void => {
    setSelected(server.id)
    setConnections(prev => ({ ...prev, [server.id]: { status: 'connecting' } }))
    loadLevel(server.id, undefined)
    const snapshot = store.getSnapshot().state
    if (snapshot !== undefined && !snapshot.remoteExpanded.includes(server.id)) {
      store.reduce(s => toggleRemoteExpanded(s, server.id))
    }
  }, [loadLevel, store])

  const toggleDir = useCallback((serverId: string, path: string): void => {
    const key = serverId + '|' + path
    loadLevel(serverId, path)
    store.reduce(s => toggleRemoteExpanded(s, key))
  }, [loadLevel, store])

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

  const renderLevel = (serverId: string, path: string, depth: number): ReactNode => {
    const key = levelKey(serverId, path)
    const level = data[key]
    if (level === undefined) {
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
              onClick={() => { toggleDir(serverId, entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleDir(serverId, entry.path) }
              }}
              onContextMenu={(event) => { openRowMenu(event, { serverId, serverName: serverNameOf(serverId), path: entry.path, isDir: true }) }}
            >
              {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
              <span className={css.explorerName}>{entry.name}</span>
            </div>
            {isOpen && renderLevel(serverId, entry.path, depth + 1)}
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
        {isOpen && conn.root !== undefined && renderLevel(server.id, conn.root, 2)}
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
