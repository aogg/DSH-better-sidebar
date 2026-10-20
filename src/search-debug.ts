/**
 * Gated debug instrumentation for the fs.search engine pipeline (host half).
 * Off by default: with DSH_SEARCH_DEBUG unset nothing is logged, nothing
 * touches the disk, and no console output is emitted. Setting
 * `DSH_SEARCH_DEBUG=1` in the dsh web environment appends one line per
 * probe/search/engine-failure to the plugin's storage-root log file
 * (`<存储根>/search-debug.log`) and mirrors it to the host console.
 *
 * The log file resolves LAZILY on every debugLog() call — it used to be
 * computed once at module load, which pinned it to whatever DSH_HOME was at
 * boot and could not follow the storage root. It deliberately reads only the
 * DEFAULT root (`<DSH_HOME||~/.dsh>/plugins/DSH-better-sidebar/`, the same
 * layout prompt-history-persist.ts owns) and NOT the user's
 * `historyStoragePath` preference: this module sits in the fs.search engine
 * dependency graph, and reading prefs here would pull the settings/config
 * graph in behind it — a circular import risk for zero benefit, since a debug
 * log that lands in the default root instead of a customized one only costs
 * archival tidiness.
 *
 * A missing/unwritable log dir must never break a search — the directory is
 * created on demand and write errors are swallowed. The gate flag is read
 * once at module load: toggling it requires restarting the host, the same as
 * any other host-side change.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultStorageRoot } from './prompt-history-persist.ts'

const SEARCH_DEBUG = process.env.DSH_SEARCH_DEBUG === '1'

/** 惰性解析日志落点（每次写时求值）：<默认存储根>/search-debug.log。
 *  刻意不读 prefs（见模块注释：避免把 settings/config 图拉进 fs.search 的
 *  依赖图），只回落 DSH_HOME/默认根。 */
function logFile(): string {
  return join(defaultStorageRoot(), 'search-debug.log')
}

/** Append one debug line (gated; no-op unless DSH_SEARCH_DEBUG=1). */
export function debugLog(msg: string): void {
  if (!SEARCH_DEBUG) return
  try {
    const file = logFile()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // A missing/unwritable log path must never break a search.
  }
  console.log(msg)
}
