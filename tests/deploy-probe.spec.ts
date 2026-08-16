/**
 * TEMPORARY probe (deployment troubleshooting): execute the DEPLOYED
 * lib/client.js inside jsdom with a host-like __ModuleLoader__, run its
 * apply() against a minimal fake ctx, and capture any startup error the
 * browser would surface (apply's own fail() writes console.error with the
 * [dsh-better-sidebar] prefix). Deleted after the investigation.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const CLIENT_PATH = 'C:/Users/SWQ/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/client.js'

interface CtxFake {
  locale: { register: () => () => void; getSnapshot?: () => { active: string } }
  effect: (fn: () => unknown, label?: string) => void
  provide: (key: string, value: unknown) => void
  slots: {
    register: (options: Record<string, unknown>, component?: unknown) => () => void
    inject: (key: string, callback: () => () => void) => () => void
  }
  sessions: unknown
  get: (key: string) => unknown
}

describe('deployed client.js probe', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads the deployed bundle and runs apply() without startup errors', async () => {
    const code = readFileSync(CLIENT_PATH, 'utf8')
    const react = await import('react')
    const reactDomClient = await import('react-dom/client')
    const jsxRuntime = await import('react/jsx-runtime')
    const primitives = await import('@deepseek-ai/dsh-client-ui-primitives')
    const moduleLoader = {
      load: (mod: { id: string; factory: (requireFn: (name: string) => unknown) => void }): void => {
        const requireFn = (name: string): unknown => {
          switch (name) {
            case 'react': return react
            case 'react-dom/client': return reactDomClient
            case 'react/jsx-runtime': return jsxRuntime
            case '@deepseek-ai/dsh-client-ui-primitives': return primitives
            default: throw new Error(`[probe] unknown require "${name}"`)
          }
        }
        mod.factory(requireFn)
      },
    }
    ;(window as unknown as { __ModuleLoader__: typeof moduleLoader }).__ModuleLoader__ = moduleLoader

    const errors: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Execute the bundle in this realm (it registers chunks + calls load).
    const run = new Function('window', 'globalThis', `${code}\n;return true`)
    expect(run(window, globalThis)).toBe(true)

    // The bundle's exports are whatever the moduleLoader cached — re-run
    // load with a capturing factory: simpler, re-execute the same code but
    // capture the module object via the loader.
    let captured: Record<string, unknown> | undefined
    const captureLoader = {
      load: (mod: { id: string; factory: (requireFn: (name: string) => unknown) => Record<string, unknown> }): void => {
        const requireFn = (name: string): unknown => {
          switch (name) {
            case 'react': return react
            case 'react-dom/client': return reactDomClient
            case 'react/jsx-runtime': return jsxRuntime
            case '@deepseek-ai/dsh-client-ui-primitives': return primitives
            default: throw new Error(`[probe] unknown require "${name}"`)
          }
        }
        // The bundle's factory RETURNS its module.exports (see its tail).
        captured = mod.factory(requireFn)
      },
    }
    ;(window as unknown as { __ModuleLoader__: typeof captureLoader }).__ModuleLoader__ = captureLoader
    const run2 = new Function('window', 'globalThis', `${code}\n;return true`)
    run2(window, globalThis)
    expect(captured).toBeDefined()
    const applyFn = captured!.apply as (ctx: CtxFake) => void
    expect(typeof applyFn).toBe('function')

    const registered: Array<{ name: string; id: string }> = []
    const ctx: CtxFake = {
      locale: {
        register: () => () => {},
        getSnapshot: () => ({ active: 'en' }),
      },
      effect: (fn: () => unknown) => {
        const result = fn()
        if (typeof result === 'function') (result as () => void)()
      },
      provide: () => {},
      slots: {
        register: (options: Record<string, unknown>) => {
          registered.push({ name: String(options.name), id: String(options.id) })
          return () => {}
        },
        inject: (_key: string, callback: () => () => void) => {
          const off = callback()
          return () => { off?.() }
        },
      },
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: 's-probe', byId: { 's-probe': { cwd: '/tmp' } } }) } },
      get: () => undefined,
    }

    applyFn(ctx)
    // Let the async mount effect (prefs load + render) settle.
    await new Promise(resolve => setTimeout(resolve, 100))

    const startupErrors = errors.filter(line => line.includes('[dsh-better-sidebar]'))
    expect(startupErrors).toEqual([])
    expect(registered.some(slot => slot.name === 'conversation.view')).toBe(false)
    // The header dock action slot registered (the manager started).
    expect(registered.some(slot => slot.name === 'conversation.session.header.actions' && slot.id === 'better-sidebar.remote-dock')).toBe(true)

    errSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
