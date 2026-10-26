/**
 * The chunk-resident command-run view (xterm lazy chunk): a light stub module
 * so the core-bundle descriptor can mount the cmd-run view without statically
 * pulling xterm. The chunk itself (src/client/chunks/terminal.tsx) loads on
 * first render via /sidebar/bundle — same lane as the bottom terminal.
 */
import type { ComponentType } from 'react'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import type { CmdRunProps } from './CmdRunView.tsx'

/** The command-run view, deferred until its tab is first mounted. */
export const LazyCmdRun = lazyChunkComponent<CmdRunProps>(
  'terminal',
  (mod) => mod.CmdRunView as ComponentType<CmdRunProps> | undefined,
)
