/**
 * Lazy chunk entry: the interactive terminal views (xterm). Built as
 * lib/client-terminal.js and fetched only when a terminal tab is first
 * opened (see chunk-loader.ts). Never import this module from the core
 * bundle: it pulls xterm into the startup path.
 */
export { TerminalView } from '../TerminalView.tsx'
export { RemoteTerminalView } from '../RemoteTerminalView.tsx'
