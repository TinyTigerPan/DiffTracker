# Diff Tracker

Diff Tracker 是一个 VS Code 扩展，用来实时记录工作区文件变化，并提供多种差异查看与变更处理方式，适合日常开发、代码审阅，以及 AI / 自动化工具改动后的快速验收。

项目当前支持三种主要查看模式：

- 行内只读 Diff 视图
- VS Code 原生左右对比视图
- 类 Cursor 风格的 WebView Diff 视图，支持块级 `Undo / Keep`

## 功能截图

**0.6.0 版本亮点：自动开始录制、会话持久化恢复、仅跟踪自动化改动、可配置 WebView 打开位置。**

| Cursor 风格 WebView（统一视图） | Cursor 风格 WebView（分栏视图） |
| :-----------------------------: | :----------------------------: |
| ![WebView Unified](./resources/webview1.png) | ![WebView Split](./resources/webview2.png) |

| 编辑器行内视图 | 编辑器行内视图（悬停效果） |
| :------------: | :-----------------------: |
| ![Inline 1](./resources/inline1.png) | ![Inline 2](./resources/inline2.png) |

| 行内视图示例 2 | 左右对比视图 |
| :------------: | :----------: |
| ![Diff 2](./resources/diff2.png) | ![Diff 3](./resources/diff3.png) |

## 核心特性

- [新增🚀] 自动在扩展激活后开始录制文件变化
- [新增🚀] 待处理、未接受的更改在VS Code重启后仍然保留，并从保存的基线中恢复
- [新增🚀] 仅适用于AI/智能体或扩展驱动编辑的自动化跟踪模式
- [新增🚀] 可配置的 WebView 打开位置（`当前组`或`旁边`）
- 支持工作区级别的文件监听，包括外部工具对磁盘文件的修改
- 支持工作区相对路径的目录树分组展示
- 支持编辑器行内高亮，区分新增、修改与词级变更
- 支持 VS Code 原生左右对比视图
- 支持类 Cursor 风格 WebView Diff，包含统一 / 分栏、换行、展开、整文件接受 / 拒绝等能力
- 支持块级操作：对单个变更块执行 `Revert` 或 `Keep`
- 支持文件级操作：`Revert File`、`Revert All Changes`、`Accept All Changes`
- 支持删除行徽标、CodeLens 操作和悬停差异说明
- 支持自定义忽略规则，使用 `.gitignore` 风格模式
- 支持“仅跟踪自动化修改”模式，适合 AI Agent、脚本或其他扩展联动

## 使用方式

1. 在 VS Code 左侧 Activity Bar 中打开 **Diff Tracker**。
2. 扩展激活后会自动开始录制；也可以手动执行：
   - `Diff Tracker: Start Recording`
   - `Diff Tracker: Stop Recording`
   - `Diff Tracker: Toggle Recording`
3. 在工作区中编辑文件，或通过外部工具改动文件。
4. 在 **Change Recording** 面板中点击已变更文件，按默认模式打开 Diff。
5. 也可以通过右键菜单或编辑器标题栏切换其他查看方式：
   - Inline Diff
   - Side-by-Side Diff
   - Webview Diff
   - Original File
   - Split: Original | Webview
6. 在 WebView Diff 中，可对每个变更块执行 `Undo / Keep`，或在文件级执行 `Keep All / Reject All`。
7. 如需清空当前基线并以当前工作区状态重新开始，可使用 `Diff Tracker: Clear Diffs`。

## 工作原理

开始录制后，Diff Tracker 会：

1. 为工作区文件建立初始基线快照
2. 监听文档和文件系统变化，并重新计算行级 / 块级差异
3. 提供虚拟文档，用于原始内容和行内 Diff 展示
4. 在树视图、编辑器装饰、CodeLens 与 WebView 之间同步状态
5. 将未接受 / 未回滚的录制结果持久化，在 VS Code 重启后恢复

## 安装

### 通过 VSIX 安装

1. 下载 `.vsix` 安装包
2. 打开 VS Code
3. 进入扩展页 `Extensions`
4. 点击右上角 `...`
5. 选择 `Install from VSIX...`
6. 选中下载的 `.vsix` 文件

### 本地开发

```bash
npm install
npm run compile
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host。

## 开发脚本

```bash
npm run compile
npm run build:webview
npm run watch
npm run lint
npm run test:webview-anchors
npm run test:similarity-pairing
npm run package
```

## 环境要求

- VS Code `^1.80.0`
- Node.js 与 npm（用于本地开发和打包）

## 配置项

| 配置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `diffTracker.showDeletedLinesBadge` | `true` | 是否显示删除行徽标 |
| `diffTracker.showCodeLens` | `true` | 是否在变更块上方显示 CodeLens 操作 |
| `diffTracker.highlightAddedLines` | `true` | 是否用绿色背景高亮新增行 |
| `diffTracker.highlightModifiedLines` | `true` | 是否用蓝色背景高亮修改行 |
| `diffTracker.highlightWordChanges` | `true` | 是否高亮修改行中的词级差异 |
| `diffTracker.defaultOpenMode` | `webview` | 点击变更文件时的默认打开方式 |
| `diffTracker.openWebviewBeside` | `false` | 是否将 WebView Diff 打开到旁边的编辑器分组 |
| `diffTracker.useGitIgnoreExcludes` | `true` | 是否应用来自 `.gitignore` 与 `.git/info/exclude` 的忽略规则 |
| `diffTracker.useBuiltInExcludes` | `true` | 是否应用内置忽略规则，例如 `.git`、`node_modules`、`dist`、`coverage` |
| `diffTracker.useVSCodeExcludes` | `true` | 是否应用 VS Code 的排除设置：`files.watcherExclude`、`search.exclude`、`files.exclude` |
| `diffTracker.watchExclude` | `[]` | 额外的监听忽略规则，使用 `.gitignore` 风格 |
| `diffTracker.onlyTrackAutomatedChanges` | `false` | 只记录自动化产生的改动，忽略手动键入 |

你可以在侧边栏的 **Settings** 面板中直接切换显示类与忽略规则相关设置，也可以通过 `Edit Watch Ignores` 编辑忽略规则。

## 默认打开模式

`diffTracker.defaultOpenMode` 支持以下取值：

- `webview`：打开交互式 WebView Diff 面板
- `inline`：打开行内只读 Diff
- `sideBySide`：打开 VS Code 原生左右对比
- `original`：直接打开原始文件
- `splitOriginalWebview`：左侧原始文件，右侧 WebView Diff

## 仅跟踪自动化改动

当 `diffTracker.onlyTrackAutomatedChanges` 为 `true` 时：

- 在 VS Code 中手动输入的内容不会被记录
- 外部 CLI、脚本或其他直接写磁盘的工具仍会通过文件监听被记录
- 其他 VS Code 扩展可以通过显式开启自动化会话，将自己的编辑纳入记录范围

其他扩展的集成示例：

```ts
const sessionId = await vscode.commands.executeCommand<string>(
  'diffTracker.beginAutomationSession',
  { allFiles: true, ttlMs: 30000 }
);

try {
  // 在这里执行 WorkspaceEdit 或编辑器改动
} finally {
  await vscode.commands.executeCommand('diffTracker.endAutomationSession', sessionId);
}
```

## 快捷键与常用命令

- `Shift + Alt + D`：切换录制状态
- `Diff Tracker: Start Recording`
- `Diff Tracker: Stop Recording`
- `Diff Tracker: Show Diffs`
- `Diff Tracker: Clear Diffs`
- `Diff Tracker: Revert All Changes`
- `Diff Tracker: Accept All Changes`
- `Diff Tracker: Select Default Open Mode`
- `Diff Tracker: Edit Watch Ignores`

## 已知问题

- 纯换行符风格变化（例如仅 `CRLF` / `LF` 切换）当前会被视为无实际内容变更
- 如果遇到可复现的 Diff 显示或渲染异常，建议提交最小复现样例以便排查

## 版本更新摘要

### 0.6.0

- 增加录制会话与工作区基线持久化，支持 VS Code 重启后恢复未处理改动
- 增加 `onlyTrackAutomatedChanges` 与自动化会话命令，便于 AI / 扩展联动
- 增加 `openWebviewBeside` 配置，并完善设置面板
- 扩展激活后自动开始录制，并自动恢复树视图与装饰状态

### 0.5.x

- 增加资源管理器右键入口 `Open with Diff Tracker`
- 支持默认打开模式配置
- 增加 `Original + WebView` 分屏模式
- 增加全局快捷键 `Shift + Alt + D`
- 优化变更树结构、文件图标、徽标和全局操作流

### 0.4.x 及更早

- 引入类 Cursor 风格 WebView Diff
- 增加强工作区文件监听与忽略规则面板
- 完善块级 `Keep / Revert`
- 增加词级高亮和设置面板
- 从基础变更录制逐步演进为多视图、多粒度的 Diff 审阅工具

## License

MIT
