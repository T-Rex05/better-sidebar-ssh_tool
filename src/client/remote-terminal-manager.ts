/**
 * Remote terminal manager: owns the per-session remote terminal records and
 * their TWO surfaces — the center view-ring tabs (conversation.view slot
 * entries next to 对话/轨迹) and the bottom-panel dock (the existing
 * Workbench). One terminal lives on exactly one surface at a time
 * (docked XOR view ring), so the shell never double-attaches.
 *
 * View-ring registrations are global slot entries; they are re-scoped to
 * the ACTIVE session on every session switch (each terminal belongs to one
 * session — the host keys shells by sessionId+tabId).
 */
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import { api } from './api.ts'
import {
  closeTab as closeTabReducer, firstLeaf, leafWithTab, removeRemoteTerminal, setRemoteTerminalDocked,
  splitLeafAt, tabOpenIn, upsertRemoteTerminal,
  type RemoteTerminalRecord, type SidebarLeaf, type SidebarSplit, type SidebarState,
  type SidebarStore, type SidebarTab, type SplitNode,
} from './state.ts'
import { isNarrowWidth } from './breakpoints.ts'
import { remoteDirLabel, setRemoteTerminalManager, type RemoteTerminalManagerFace, type RemoteTerminalMeta } from './remote-terminal-shared.tsx'
import { RemoteCenterTerminalView } from './RemoteCenterTerminalView.tsx'
import { RemoteDockAction } from './RemoteDockAction.tsx'
import { t } from './locales.ts'

/** Find a leaf by pane id inside one split tree. */
function leafById(node: SplitNode, id: string): SidebarLeaf | undefined {
  if (node.kind === 'leaf') return node.id === id ? node : undefined
  for (const child of node.children) {
    const hit = leafById(child, id)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Append one tab to a specific leaf of a tree (sets it active). */
function placeTab(tree: SplitNode, paneId: string, tab: SidebarTab): SplitNode {
  const walk = (node: SplitNode): SplitNode => {
    if (node.kind === 'leaf') {
      if (node.id !== paneId) return node
      return { ...node, tabs: [...node.tabs, tab], active: tab.id }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return walk(tree)
}

export class RemoteTerminalManager implements RemoteTerminalManagerFace {
  private readonly viewDisposers = new Map<string, () => void>()
  private lastKey = ''
  private started = false

  constructor(
    private readonly ctx: Context,
    private readonly store: SidebarStore,
  ) {}

  /** Register the manager + slots; returns the disposer (HMR-safe). */
  start(): () => void {
    if (this.started) return () => {}
    this.started = true
    setRemoteTerminalManager(this)
    const offStore = this.store.subscribe(() => { this.reconcile() })
    // The 分栏 action beside the session title (chat view → one-click dock).
    const offHeader = this.ctx.slots.inject('conversation.session.header.actions', () => {
      const alive = { live: true }
      const dispose = this.ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'better-sidebar.remote-dock',
        order: 100,
        label: () => t('remoteDock'),
        inject: (sessionId: string) => ({ sessionId, manager: this, store: this.store }),
      }, RemoteDockAction)
      return () => { alive.live = false; dispose() }
    })
    this.reconcile()
    return () => {
      this.started = false
      offStore()
      offHeader()
      this.disposeViews()
      setRemoteTerminalManager(null)
    }
  }

  /** Rebuild the view-ring entries when the session or the record set changes. */
  private reconcile(): void {
    const snapshot = this.store.getSnapshot()
    const sessionId = snapshot.sessionId
    const records = snapshot.state?.remoteTerminals ?? []
    const key = (sessionId ?? '') + '|' + records.map(r => r.tabId + ':' + (r.docked ? '1' : '0')).join(',')
    if (key === this.lastKey) return
    this.lastKey = key
    this.disposeViews()
    if (sessionId === undefined) return
    for (const record of records) {
      if (record.docked) continue
      this.registerView(record)
    }
  }

  private disposeViews(): void {
    for (const dispose of [...this.viewDisposers.values()]) {
      try { dispose() } catch { /* already disposed */ }
    }
    this.viewDisposers.clear()
  }

  /** Register one conversation.view tab for a terminal. */
  private registerView(record: RemoteTerminalRecord): void {
    if (this.viewDisposers.has(record.tabId)) return
    const alive = { live: true }
    const off = this.ctx.slots.inject('conversation.view', () => {
      if (!alive.live) return () => {}
      const dispose = this.ctx.slots.register({
        name: 'conversation.view',
        id: 'better-sidebar.remote-term:' + record.tabId,
        order: 100,
        label: () => record.serverName + ': ' + remoteDirLabel(record.dir),
        inject: (sessionId: string) => ({
          sessionId,
          record,
          store: this.store,
          manager: this,
        }),
      }, RemoteCenterTerminalView)
      return () => { dispose() }
    })
    this.viewDisposers.set(record.tabId, () => {
      alive.live = false
      off()
    })
  }

  /** Open one remote terminal: mint the id, persist the record, register
   *  the view-ring tab. The host creates the ssh2 shell on first WS attach. */
  openRemoteTerminal(scope: SessionScope, meta: RemoteTerminalMeta): void {
    void scope
    const state = this.store.getSnapshot().state
    if (state === undefined) return
    const tabId = 'remote-term:' + state.nextRemoteTerminal
    this.store.reduce(s => ({
      ...upsertRemoteTerminal(s, { tabId, serverId: meta.serverId, serverName: meta.serverName, dir: meta.dir, docked: false }),
      nextRemoteTerminal: s.nextRemoteTerminal + 1,
    }))
  }

  /** Move a terminal from the view ring into the dock (chat + terminal split). */
  dockTerminal(sessionId: string, tabId: string): void {
    const snapshot = this.store.getSnapshot()
    if (snapshot.sessionId !== sessionId || snapshot.state === undefined) return
    this.store.reduce(s => {
      const record = s.remoteTerminals.find(r => r.tabId === tabId)
      if (record === undefined || record.docked) return s
      let next = setRemoteTerminalDocked(s, tabId, true)
      if (tabOpenIn(next, tabId)) return next
      const tab: SidebarTab = {
        id: tabId,
        type: 'remote-terminal',
        title: record.serverName + ': ' + remoteDirLabel(record.dir),
        meta: { serverId: record.serverId, serverName: record.serverName, dir: record.dir } satisfies RemoteTerminalMeta,
      }
      // Narrow viewports have no bottom panel: the dock degrades to the
      // right drawer's first pane (still a split surface).
      if (typeof window !== 'undefined' && isNarrowWidth(window.innerWidth)) {
        const paneId = next.activePane !== null && leafById(next.splits, next.activePane) !== undefined
          ? next.activePane
          : firstLeaf(next.splits).id
        return { ...next, splits: placeTab(next.splits, paneId, tab), activePane: paneId, panelOpen: true }
      }
      let tree = next.bottomSplits
      let paneId = next.activePane !== null && leafById(tree, next.activePane) !== undefined
        ? next.activePane
        : firstLeaf(tree).id
      const pane = leafById(tree, paneId)
      // A second terminal: auto-split the pane right so two terminals are
      // visible at once (VSCode-style); further docks stack via the strip.
      if (pane !== undefined && pane.tabs.some(candidate => candidate.type === 'remote-terminal')) {
        tree = splitLeafAt(tree, paneId, 'row')
        const split = tree as SidebarSplit
        const fresh = split.children[split.children.length - 1]!
        paneId = fresh.kind === 'leaf' ? fresh.id : firstLeaf(fresh).id
      }
      return {
        ...next,
        bottomSplits: placeTab(tree, paneId, tab),
        bottomOpen: true,
        activePane: paneId,
      }
    })
  }

  /** Move a docked terminal back to the view ring (the shell survives). */
  undockTerminal(sessionId: string, tabId: string): void {
    const snapshot = this.store.getSnapshot()
    if (snapshot.sessionId !== sessionId) return
    this.store.reduce(s => {
      const record = s.remoteTerminals.find(r => r.tabId === tabId)
      if (record === undefined || !record.docked) return s
      let next = setRemoteTerminalDocked(s, tabId, false)
      const leaf = leafWithTab(next.splits, tabId) ?? leafWithTab(next.bottomSplits, tabId)
      if (leaf !== undefined) next = closeTabReducer(next, leaf.id, tabId)
      return next
    })
  }

  /** Kill one terminal: record, any tab, the view-ring entry, and the shell. */
  closeTerminal(sessionId: string, tabId: string): void {
    this.store.reduce(s => {
      if (!s.remoteTerminals.some(r => r.tabId === tabId)) return s
      let next = removeRemoteTerminal(s, tabId)
      const leaf = leafWithTab(next.splits, tabId) ?? leafWithTab(next.bottomSplits, tabId)
      if (leaf !== undefined) next = closeTabReducer(next, leaf.id, tabId)
      return next
    })
    void api.remoteShellClose({ sessionId }, tabId).catch(() => { /* already released */ })
  }

  /** The header 分栏 button: dock the latest terminal or collapse the dock. */
  toggleDock(sessionId: string): void {
    const state = this.store.getSnapshot().state
    if (state === undefined) return
    const records = state.remoteTerminals
    if (records.length === 0) return
    if (records.some(r => r.docked)) {
      this.store.reduce(s => ({ ...s, bottomOpen: false }))
      return
    }
    const undocked = records.filter(r => !r.docked)
    if (undocked.length === 0) return
    this.dockTerminal(sessionId, undocked[undocked.length - 1]!.tabId)
  }

  /** Whether the session has any remote terminal (gates the header button). */
  hasTerminals(sessionId: string): boolean {
    const snapshot = this.store.getSnapshot()
    return snapshot.sessionId === sessionId
      && (snapshot.state?.remoteTerminals.length ?? 0) > 0
  }
}
