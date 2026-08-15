/**
 * Remote terminal manager spec (client side): the per-session remote
 * terminal records and their TWO surfaces — conversation.view ring tabs
 * (next to 对话/轨迹) and the bottom-panel dock. Covers open / dock /
 * undock / close, the auto-split of a second docked terminal, the view-ring
 * reconciliation, and the header 分栏 toggle. The slots service is a
 * structural fake (declared already: inject runs the callback immediately);
 * the shell-close HTTP call fails against the test environment and is
 * swallowed by the manager (asserted via the spy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// First import: browser globals before the builtin client graph loads.
import './browser-globals.ts'

import type { Context } from '../src/context-types.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { allLeaves } from '../src/client/state.ts'
import { RemoteTerminalManager } from '../src/client/remote-terminal-manager.ts'
import { getRemoteTerminalManager } from '../src/client/remote-terminal-shared.tsx'
import { api, type SessionScope } from '../src/client/api.ts'

interface RegisteredSlot {
  name: string
  id: string
  options: Record<string, unknown>
}

function setup(): {
  store: ReturnType<typeof createSidebarStore>
  manager: RemoteTerminalManager
  registered: RegisteredSlot[]
  dispose: () => void
  slots: { disposeCount: () => number }
} {
  const store = createSidebarStore()
  store.setSession('s1')
  const registered: RegisteredSlot[] = []
  let disposals = 0
  const slots = {
    register: (options: Record<string, unknown>, _component: unknown) => {
      const entry: RegisteredSlot = {
        name: String(options.name),
        id: String(options.id),
        options,
      }
      registered.push(entry)
      return () => {
        // Mirror the real slots service: a disposed registration leaves
        // the ledger (and its disposer is idempotent).
        const at = registered.indexOf(entry)
        if (at !== -1) registered.splice(at, 1)
        disposals += 1
      }
    },
    inject: (_key: string, callback: () => () => void) => {
      const off = callback()
      return () => { off?.() }
    },
  }
  const ctx = { slots } as unknown as Context
  const manager = new RemoteTerminalManager(ctx, store)
  const dispose = manager.start()
  return {
    store,
    manager,
    registered,
    dispose,
    slots: { disposeCount: () => disposals },
  }
}

const scope: SessionScope = { sessionId: 's1' }
const meta = { serverId: 'srv-1', serverName: 'prod', dir: '/var/www' }

const bottomTabs = (store: ReturnType<typeof createSidebarStore>): string[] =>
  allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs).map(tab => tab.id)

const viewRingIds = (registered: RegisteredSlot[]): string[] =>
  registered.filter(slot => slot.name === 'conversation.view').map(slot => slot.id)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remote terminal manager', () => {
  it('openRemoteTerminal mints records and registers a view-ring tab per terminal', () => {
    const { store, manager, registered } = setup()
    expect(registered.some(slot => slot.name === 'conversation.session.header.actions')).toBe(true)
    manager.openRemoteTerminal(scope, meta)
    manager.openRemoteTerminal(scope, { ...meta, dir: '/opt' })
    const state = store.getSnapshot().state!
    expect(state.remoteTerminals).toEqual([
      { tabId: 'remote-term:1', serverId: 'srv-1', serverName: 'prod', dir: '/var/www', docked: false },
      { tabId: 'remote-term:2', serverId: 'srv-1', serverName: 'prod', dir: '/opt', docked: false },
    ])
    expect(state.nextRemoteTerminal).toBe(3)
    expect(viewRingIds(registered)).toEqual([
      'better-sidebar.remote-term:remote-term:1',
      'better-sidebar.remote-term:remote-term:2',
    ])
  })

  it('dockTerminal moves the terminal into the bottom workbench (chat + terminal split)', () => {
    const { store, manager, registered } = setup()
    manager.openRemoteTerminal(scope, meta)
    const viewId = 'better-sidebar.remote-term:remote-term:1'
    manager.dockTerminal('s1', 'remote-term:1')
    let state = store.getSnapshot().state!
    expect(state.remoteTerminals[0]!.docked).toBe(true)
    expect(state.bottomOpen).toBe(true)
    expect(bottomTabs(store)).toEqual(['remote-term:1'])
    // The view-ring entry was disposed (one surface at a time).
    expect(registered.filter(slot => slot.id === viewId)).toHaveLength(0)
    // The docked tab has the remote-terminal type with the meta.
    const tab = allLeaves(state.bottomSplits)[0]!.tabs[0]!
    expect(tab.type).toBe('remote-terminal')
    expect(tab.meta).toEqual(meta)

    // A SECOND terminal auto-splits the dock pane right (VSCode-style).
    manager.openRemoteTerminal(scope, { ...meta, dir: '/opt' })
    manager.dockTerminal('s1', 'remote-term:2')
    state = store.getSnapshot().state!
    expect(state.bottomSplits.kind).toBe('split')
    expect(bottomTabs(store).sort()).toEqual(['remote-term:1', 'remote-term:2'])
  })

  it('undockTerminal returns the terminal to the view ring (the shell survives)', () => {
    const { store, manager, registered } = setup()
    manager.openRemoteTerminal(scope, meta)
    manager.dockTerminal('s1', 'remote-term:1')
    manager.undockTerminal('s1', 'remote-term:1')
    const state = store.getSnapshot().state!
    expect(state.remoteTerminals[0]!.docked).toBe(false)
    expect(bottomTabs(store)).toEqual([])
    // The view ring registration is back.
    expect(viewRingIds(registered)).toContain('better-sidebar.remote-term:remote-term:1')
  })

  it('closeTerminal removes the record, the tab (either tree) and releases the shell', async () => {
    const spy = vi.spyOn(api, 'remoteShellClose')
    const { store, manager } = setup()
    manager.openRemoteTerminal(scope, meta)
    manager.dockTerminal('s1', 'remote-term:1')
    manager.closeTerminal('s1', 'remote-term:1')
    const state = store.getSnapshot().state!
    expect(state.remoteTerminals).toEqual([])
    expect(bottomTabs(store)).toEqual([])
    expect(spy).toHaveBeenCalledWith({ sessionId: 's1' }, 'remote-term:1')
    // The HTTP call fails in the test env; the manager swallows it.
    await Promise.resolve()
    // Closing an already-closed terminal is a no-op.
    manager.closeTerminal('s1', 'remote-term:1')
    expect(store.getSnapshot().state!.remoteTerminals).toEqual([])
  })

  it('toggleDock docks the latest undocked terminal, then collapses the dock', () => {
    const { store, manager } = setup()
    manager.openRemoteTerminal(scope, meta)
    manager.openRemoteTerminal(scope, { ...meta, dir: '/opt' })
    manager.toggleDock('s1')
    let state = store.getSnapshot().state!
    expect(state.remoteTerminals.find(r => r.docked)?.tabId).toBe('remote-term:2')
    // A docked terminal exists → toggle collapses the panel instead.
    manager.toggleDock('s1')
    state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(false)
    expect(state.remoteTerminals.find(r => r.docked)?.tabId).toBe('remote-term:2')
  })

  it('hasTerminals gates on the session and the record count', () => {
    const { manager } = setup()
    expect(manager.hasTerminals('s1')).toBe(false)
    manager.openRemoteTerminal(scope, meta)
    expect(manager.hasTerminals('s1')).toBe(true)
    expect(manager.hasTerminals('other-session')).toBe(false)
  })

  it('start() is idempotent and dispose() tears the manager down (HMR-safe)', () => {
    const { store, manager, registered, dispose, slots } = setup()
    const before = registered.length
    expect(manager.start()).toBeInstanceOf(Function) // second start: no-op disposer
    expect(registered.length).toBe(before)
    manager.openRemoteTerminal(scope, meta)
    dispose()
    expect(getRemoteTerminalManager()).toBeNull()
    // The manager no longer reconciles (the store subscription is off):
    // the post-dispose open still records (the manager object stays usable)
    // but never registers a view-ring slot.
    manager.openRemoteTerminal(scope, { ...meta, dir: '/x' })
    expect(store.getSnapshot().state!.remoteTerminals).toHaveLength(2)
    expect(viewRingIds(registered)).not.toContain('better-sidebar.remote-term:remote-term:2')
    expect(slots.disposeCount()).toBeGreaterThan(0)
  })
})
