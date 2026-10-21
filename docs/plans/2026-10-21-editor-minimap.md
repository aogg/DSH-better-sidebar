# 文件页编辑器 minimap（VSCode 式右侧文件预览条）

> 需求原文：「查看文件的时候，参考vscode查看文件的右边有个文件预览条」。
> 口径：VSCode 编辑器右侧 minimap 的最小可用形态——整份文档缩略 + 视口滑块 +
> 点击/拖动/滚轮跳转；不做语法逐 token 配色，不做 minimap 自身滚动。

## 落地内容

- 新增 `src/client/EditorMinimap.tsx`（只能被 TextEditor.tsx 导入，随编辑器
  chunk `lib/client-editor.js` 加载，核心 bundle 不拉 CodeMirror）：
  - canvas 画墨迹条：每采样行一条，行距 2px（`MINIMAP_ROW_HEIGHT`）；按
    「首/尾非空白字符」画条，x 按最大行长映射、上限 200 列截断
    （`MINIMAP_MAX_COLUMNS`）；文档总行数×行距超过条高时按步长采样
    （`minimapStride`），整份文档始终完整落入条内，条本身永不滚动；
  - 视口滑块是普通 div（`viewportBand` 比例映射），滚动只动它、不重绘 canvas；
  - 深浅色各一组 rgba（canvas 读不了 CSS 变量），容器类名随 `dark` 翻转并重绘。
- 交互全部只写 `view.scrollDOM.scrollTop`（+ `requestMeasure`），绝不用
  CodeMirror 的 scrollIntoView（会拖动整个侧栏，见 TextEditor 既有注释）：
  按下/拖动 = 滑块居中对齐跟随指针（`scrollTopForPointer`），滚轮 = 原生
  非被动监听转发 `deltaY` 给编辑器。
- 位置：TextEditor 把 `editorCm` 与 minimap 包进 flex row（`editorCmRow`），
  占布局宽度（非悬浮遮挡），宽 60px；row 才是 editorMain 的 flex 子元素且由它
  承担 preview 隐藏类，markdown/html/jsonl 渲染型预览仍独占整栏。
- 宽度自适应：编辑器栏 < 420px（`MINIMAP_MIN_EDITOR_WIDTH`，CSS 侧用
  `@container (max-width: 419px)` 镜像，测试钉住两处一致）整条隐藏。

## 开关与作用面

- 新增偏好 `editorMinimap`（默认开），完全镜像 `editorGitGutter`：
  `prefs-shared.ts` 默认值 + `config.ts` schema + `client/prefs.ts` 解析 +
  Side card 设置里 code/jsonl/html viewer 的 `settings.toggles` 行（html 的
  edit 模式也是文本面；markdown viewer 本无设置卡片，未加）。
- 作用面 = CodeMirror 表面：`code` 常显；markdown/html/jsonl 仅 edit 模式
  （preview `showingPreview` 时连 row 一起 display:none）；LargeFileView 无
  编辑器自然不显示。
- 文案 key `settingsEditorMinimapTitle/Desc` 进了 zh/en + 全部 19 个第三语言
  字典（本项目字典是全量覆盖，有 key-set 相等测试兜底）。

## 实现要点

- 只观察不侵入：minimap 不装任何 CodeMirror 扩展。TextEditor 在视图创建后与
  `docChanged` 时调用 minimap 注册进 `minimapSyncRef` 的 `sync()`（重绑滚动
  监听 + rAF 重绘，`frame-batcher.ts` 节流）；挂载/滚轮/resize（ResizeObserver +
  window resize）由组件自理。文本编辑器的 #826 定位、搜索面板、git gutter、
  选择弹窗、草稿/保存链路零改动。
- 每键击重绘是 rAF 合并的一次 O(doc) 行扫描（`lineInkSpan` 纯函数），不触发
  React 重渲染（不走 setState）。
- jsdom 安全：`canvas.getContext('2d')` 为 null（测试环境）时容器照常渲染、
  跳过绘制不抛错；所有布局数学是纯函数，jsdom 无布局也能测比例计算。

## 纯函数清单（tests/editor-minimap.spec.tsx 覆盖）

`minimapStride` / `lineInkSpan` / `minimapBandHeight` / `viewportBand` /
`scrollTopForPointer`，常量 `MINIMAP_ROW_HEIGHT=2`、`MINIMAP_MAX_COLUMNS=200`、
`MINIMAP_MIN_EDITOR_WIDTH=420`。

## 未做清单

- 语法逐 token 配色（只按行画单色墨迹条）。
- minimap 自身滚动/缩放倍率切换/滑块外点击按页翻动（VSCode 的 stage 模式）。
- 渲染型预览（markdown/html 渲染、iframe）不放 minimap。
- 当前编辑行高亮、光标位置标记。
- e2e（本仓库约定不跑 playwright）。
