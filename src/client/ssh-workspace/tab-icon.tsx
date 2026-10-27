/**
 * 「远程工作区」的 tab 图形：VSCodicon 的 Remote Explorer（VS Code 的远程
 * 指示器族），风格对齐 builtins/tab-icons.tsx——`TabIcon` 签名、`themed`
 * 包裹、令牌上色（颜色本体在 {@link ./tab-icon.module.css}，零字面量）。
 */
import type { ReactNode } from 'react'
import { VscRemoteExplorer } from 'react-icons/vsc'
import type { TabIcon } from '../builtins/tab-icons.tsx'
import styles from './tab-icon.module.css'

const css = styles as Record<'glyph', string>

/** 用 token 上色的包裹类包住 glyph（与 builtins 的 themed 同一形制）。 */
function themed(className: string, glyph: ReactNode): ReactNode {
  return <span className={className}>{glyph}</span>
}

/** 「远程工作区」tab / 开始页胶囊共用的彩色图形（14px 于 tab 条）。 */
export const sshWorkspaceTabIcon: TabIcon = (size) => (
  themed(css.glyph, <VscRemoteExplorer size={size} />)
)
