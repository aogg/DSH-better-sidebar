/**
 * Lazy chunk entry: the bottom workbench's terminal emulator (xterm.js + the
 * fit addon, several hundred KB). Built as `lib/client-terminal.js` and
 * registered under the `terminal` global chunk slot — fetched only when the
 * bottom tray's terminal tab is first opened (see chunk-loader.ts and
 * src/client/TerminalView.tsx). Never import this module from the core bundle:
 * it pulls xterm into the startup path.
 *
 * 「命令」开始页的执行 tab（CmdRunView）也挂在这一颗 chunk 上：同一份 xterm
 * 运行时，两个表面共享一次下载（lazy-chunk.ts 的 cache 去重）。
 */
export { TerminalBottomView } from '../TerminalView.tsx'
export { CmdRunView } from '../CmdRunView.tsx'
