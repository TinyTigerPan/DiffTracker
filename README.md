# Diff Tracker

[中文说明](./README_CN.md)


Diff Tracker is a VS Code extension that records file changes and provides three review modes:
- Inline readonly diff document
- VS Code side-by-side diff
- Cursor-like WebView diff with floating Undo/Keep actions

**Fork From [wizyoung/DiffTracker](https://github.com/wizyoung/DiffTracker)**


## Screenshots

**Highlights in 0.6.10: Documentation and release metadata refresh.**

| Cursor like WebView Unified | Cursor like WebView Split |
|:---------------:|:--------------:|
| ![Word diff](./resources/webview1.png) | ![Settings](./resources/webview2.png) |

|               Editor Inline View                |    Editor Inline View (hover effect)    |
| :---------------------------------------------: | :-------------------------------------: |
| ![Editor highlighting](./resources/inline1.png) | ![Inline diff](./resources/inline2.png) |

| Inline View 2 | Side-by-side diff |
|:---------------:|:--------------:|
| ![Word diff](./resources/diff2.png) | ![Settings](./resources/diff3.png) |


## Features
- [New 🚀] Pending, unaccepted changes survive VS Code restarts and are restored from the saved baseline
- [New 🚀] Automation-only tracking mode for AI/agent or extension-driven edits
- [New 🚀] Block revert actions when unsaved editor content no longer matches the tracked diff
- [New 🚀] Hide stale CodeLens, hovers, and inline decorations until dirty editors are saved, reverted, or reloaded
- [New 🚀] Configurable WebView opening position (`current group` or `beside`)
- [New 🚀] WebView diff overview ruler with clickable change markers and a live viewport indicator
- [New 🚀] Automatically start recording file changes after the extension is activated
- [New 🚀] Show workspace-relative file paths in the Change Recording tree
- [New 🚀] Toggle folder grouping in the Change Recording tree
- [New 🚀] Group Change Recording tree row icons with clear gaps before Revert and Accept actions
- [New 🚀] Confirm whole-file revert actions before they run
- [New 🚀] Accept or revert all tracked changes under a folder from the Change Recording tree
- [New 🚀] Configure separate safety confirmations for folder accepts and folder reverts
- [New 🚀] Split VS Code exclude inheritance across `files.exclude`, `search.exclude`, and `files.watcherExclude`
- [New 🚀] Workspace-relative glob matching for inherited VS Code excludes
- Activity Bar **Change Recording** tree with file grouping
- Recording mode (start/stop) with workspace baseline snapshot
- Workspace-wide file watching (including external file changes)
- Inline readonly diff view with line and word-level highlights
- Side-by-side diff (`Original ↔ Current`) via built-in VS Code diff
- Cursor-like WebView diff (Split/Unified, Wrap, Expand, Keep All, Reject All, overview ruler)
- Block-wise actions: Undo/Keep per change block
- File-level and folder-level actions: Revert file, Revert all files, Keep all changes in file, Accept/Revert folder changes, with separated tree row action icons
- Deleted-line badge, CodeLens actions, and hover details
- Settings panel + Watch Ignore editor (`.gitignore` style patterns)

## Usage

1. Open **Diff Tracker** from the Activity Bar.
2. Recording starts automatically after the extension activates.
3. Edit files in your workspace.
4. In **Change Recording**, click a changed file to open inline diff.
5. Use context menu or editor title buttons to open:
   - Inline Diff (active file)
   - Side-by-Side Diff
   - WebView Diff
6. In WebView Diff, use the overview ruler to jump between change blocks, then use block-level **Undo/Keep** or file-level **Keep All/Reject All**.
7. Use **Revert File**, **Revert All Changes**, or folder-level **Accept/Revert** actions as needed.
8. Stop recording when done.

## How It Works

When recording starts, Diff Tracker:
1. Captures baseline snapshots for workspace files (batched)
2. Tracks file/document changes and rebuilds line/block diffs
3. Serves virtual inline/original documents
4. Restores pending changes after restart until they are accepted/reverted or the baseline is cleared
5. Keeps tree, decorations, CodeLens, and WebView in sync

## Installation

### From VSIX
1. Download the .vsix file
2. Open VS Code
3. Open Extensions (Cmd+Shift+X)
4. Click ... -> Install from VSIX...
5. Select the downloaded .vsix

### Development
1. Clone the repository
2. Run npm install
3. Run npm run compile
4. Press F5 to launch the Extension Development Host

## Requirements

- VS Code ^1.80.0

## Extension Settings

This extension provides the following settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `diffTracker.showDeletedLinesBadge` | `true` | Show a badge indicating deleted lines |
| `diffTracker.showCodeLens` | `true` | Show CodeLens actions (Revert/Keep) above change blocks |
| `diffTracker.highlightAddedLines` | `true` | Highlight added lines with green background |
| `diffTracker.highlightModifiedLines` | `true` | Highlight modified lines with blue background |
| `diffTracker.highlightWordChanges` | `true` | Highlight word-level changes within modified lines |
| `diffTracker.openWebviewBeside` | `false` | Open Webview diff in a side editor group instead of the current editor group |
| `diffTracker.webviewDefaultSplit` | `true` | Open newly created Webview diff panels in Split mode instead of Unified mode |
| `diffTracker.showFullFilePaths` | `false` | Show project-relative file paths in the Change Recording tree instead of only the file name |
| `diffTracker.showFolders` | `true` | Show folders in the Change Recording tree |
| `diffTracker.confirmReversions` | `true` | Show a confirmation dialog before reverting all changes or reverting all changes in a file |
| `diffTracker.confirmFolderReversions` | `true` | Show a confirmation dialog before reverting all changes under a folder |
| `diffTracker.confirmFolderAccepts` | `true` | Show a confirmation dialog before accepting all changes under a folder |
| `diffTracker.useGitIgnoreExcludes` | `true` | Apply ignore rules from `.gitignore` files and `.git/info/exclude` |
| `diffTracker.useBuiltInExcludes` | `true` | Apply built-in ignore rules for common folders like `.git`, `node_modules`, `dist`, and `coverage` |
| `diffTracker.useVSCodeExcludes` | `true` | Deprecated compatibility setting for VS Code exclude inheritance |
| `diffTracker.useVSCodeFilesExcludes` | `true` | Apply VS Code Explorer exclude settings from `files.exclude`. Conditional object rules are ignored. |
| `diffTracker.useVSCodeSearchExcludes` | `false` | Apply VS Code search exclude settings from `search.exclude`. Conditional object rules are ignored. |
| `diffTracker.useVSCodeWatcherExcludes` | `false` | Apply VS Code watcher exclude settings from `files.watcherExclude`. Conditional object rules are ignored. |
| `diffTracker.watchExclude` | `[]` | Additional watch ignore patterns (`.gitignore` style) |
| `diffTracker.onlyTrackVSCodeChanges` | `false` | Deprecated alias for automation-only tracking |
| `diffTracker.onlyTrackAutomatedChanges` | `false` | Ignore unsaved manual typing in VS Code. Saved editor changes, external CLI/tool edits, and tagged extension edits are tracked |

You can toggle display/highlight/ignore settings in the sidebar **Settings** panel, and edit watch ignore patterns via **Edit Watch Ignores**.

VS Code exclude inheritance is split across `files.exclude`, `search.exclude`, and `files.watcherExclude`. Diff Tracker applies boolean glob rules from those settings and ignores conditional object rules such as `{ "when": "$(basename).ts" }`.

`diffTracker.useVSCodeExcludes` remains as a deprecated compatibility setting.

When `diffTracker.openWebviewBeside` is enabled, Webview diff opens in a side editor group. By default it opens in the current editor group.

When `diffTracker.webviewDefaultSplit` is disabled, newly created Webview diff panels open in Unified mode. Toolbar changes remain local to the currently open panel.

When `diffTracker.onlyTrackAutomatedChanges` is enabled:
- Unsaved manual typing in the editor is ignored
- Saved editor changes are tracked through the save/watch paths
- External tools/CLI that modify files on disk are still tracked through file watchers
- VS Code extensions should call `diffTracker.beginAutomationSession` before applying edits, and `diffTracker.endAutomationSession` after they finish

Example integration from another VS Code extension:

```ts
const sessionId = await vscode.commands.executeCommand<string>(
  'diffTracker.beginAutomationSession',
  { allFiles: true, ttlMs: 30000 }
);

try {
  // apply WorkspaceEdit or editor edits here
} finally {
  await vscode.commands.executeCommand('diffTracker.endAutomationSession', sessionId);
}
```

## Known Issues

- Pure line-ending-style changes (CRLF/LF only) are currently treated as no logical content change.
- If you find a reproducible diff/render edge case, please open an issue with a minimal file sample.

## Release Notes

### 0.6.10

- Bump extension version to `0.6.10`
- Refresh README release metadata and latest-version highlight

### 0.1.0

- Activity Bar entry
- Recording mode for change tracking
- Inline diff highlighting
- Side-by-side diff
- Multi-file tracking with timestamps
- Revert file and revert all
- Clear diffs

### 0.2.0
- Change from LCS-based diff to Patience Diff algorithm for more intuitive diff display

### 0.3.0
- Add Partial Revert/Keep buttons, just like cursor
- Add go-to-original-file button in left panel

### 0.3.1
- Add file-level "Revert All" / "Keep All" buttons (CodeLens at file top)
- Add settings panel in sidebar to toggle display options
- Fix block-wise keep/revert affecting all blocks instead of just one
- Fix hover showing "unknown" for deleted empty lines

### 0.3.2
- Tiny bug fix

### 0.3.3
- Add word-level diff highlighting for modified lines
- Add "Highlight Word Changes" setting to toggle word-level highlighting

### 0.4.0
- Cursor-like WebView diff: floating Undo/Keep, unified view default, wrap/expand, and Keep All/Reject All in the toolbar
- Offline WebView rendering (bundled @pierre/diffs)
- Workspace-wide file watching (no longer limited to open files)
- New Watch Ignore panel with `.gitignore` support
- Faster tracking in large workspaces (debounced changes + optimized watchers)
- Smoother recording start on big repos (baseline builds in batches, large files skipped)

### 0.4.1
- Refactor diff pipeline to use a unified logical-line model
- Stabilize block grouping for large paste/delete and EOF scenarios
- Fix WebView empty-file rendering fallback that could hide block actions after full deletion
- Unify inline virtual URI mapping and refresh flow to prevent stale inline readonly content
- Improve mixed newline handling (LF/CRLF/CR) in Keep/Revert block operations

### 0.5.0
- Add Explorer file context action for Diff Tracker while recording, with the final label: **Open with Diff Tracker**
- Add configurable default open mode for changed files (WebView / Inline / Side-by-side / Original / Split Original+WebView)
- Add `Open split view` mode (left original file + right WebView diff)
- Add global recording toggle shortcut: `Shift+Alt+D`
- Improve changes tree to workspace-relative nested directory grouping
- Use VS Code native file icons in the changes tree
- Show changed-file count badge on the Diff Tracker activity icon
- Add and streamline global file actions in changes view workflows (Keep All / Revert All)
- Add `Clear Diffs` baseline reset to current workspace state
- lots of optimizations & fixes

### 0.5.1
- Improve recording controls in Change Recording with inline start entry, starting status, and title start/stop actions

### 0.5.2
- Fix watch ignore rules not refreshing in some recording states
- Reuse snapshot filtering in watcher updates to avoid tracking binary/oversized files
- Clear pre-seeded empty baseline for non-trackable created files in watcher flow

### 0.6.0
- Persist recording session state and workspace baselines so pending diffs can be restored after restarting VS Code
- Add `diffTracker.onlyTrackAutomatedChanges` plus `diffTracker.beginAutomationSession` / `diffTracker.endAutomationSession` for automation-aware tracking workflows
- Add `diffTracker.openWebviewBeside`, expose the new recording/display toggles in the settings tree, and make WebView diff open behavior more configurable
- Start recording automatically after activation and restore decorations/tree state when a previous session is resumed

### 0.6.2
- Add `CompileToVSIX.bat` for packaging the extension
- Add `diffTracker.showFullFilePaths` for project-relative file paths in the changes tree
- Add `diffTracker.confirmReversions` to confirm whole-file revert actions
- Handle cancelled revert confirmations cleanly in the webview

### 0.6.3
- Split VS Code exclude inheritance into separate settings for `files.exclude`, `search.exclude`, and `files.watcherExclude`
- Add workspace-relative glob matching for inherited VS Code excludes
- Update the settings UI and docs to reflect the new exclude settings and their conditional-rule limits

### 0.6.4
- Add Accept Folder Changes and Revert Folder Changes actions to folder rows in the Change Recording tree
- Add recursive folder accept/revert handling for all tracked files under the selected folder
- Add `diffTracker.confirmFolderReversions` and `diffTracker.confirmFolderAccepts` safety settings, both enabled by default

### 0.6.5
- Add `diffTracker.showFolders` to toggle folder grouping in the Change Recording tree

### 0.6.6
- Group Change Recording tree row icons with icon-sized gaps before Revert and Accept actions
- Add hidden no-op spacer commands and a transparent spacer icon for VS Code tree inline actions

### 0.6.7
- Add a WebView diff overview ruler beside the diff content
- Show clickable change markers for added, deleted, and modified blocks
- Track the visible scroll viewport in the overview ruler to speed up navigation through large diffs

### 0.6.8
- Fix Vibe Coding Only missing saved Codex/VS Code agent edits by tracking saved editor changes without suppressing watcher events
- Preserve pre-save baselines for files first seen through saved editor changes
- Prevent baseline initialization from overwriting a snapshot captured during a concurrent save

### 0.6.9
- Prevent whole-file, folder, and block revert actions from running when unsaved editor content no longer matches the tracked diff
- Hide stale CodeLens, hover details, and inline decorations for dirty out-of-sync editors
- Resolve folder-level accept/revert actions from the current tracked files under that folder

## License

MIT

## Acknowledge
[![LinuxDO](https://img.shields.io/badge/Community-Linux.do-blue?style=flat-square)](https://linux.do/)

Discuss, free ai, and get help at [linux.do](https://linux.do/).
