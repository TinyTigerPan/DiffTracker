# Diff Tracker

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Diff%20Tracker-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Wizyoung.diff-tracker)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Diff%20Tracker-5E60E7?logo=opensourceinitiative&logoColor=white)](https://open-vsx.org/extension/Wizyoung/diff-tracker)

Diff Tracker is a VS Code extension that records file changes and provides three review modes:
- Inline readonly diff document
- VS Code side-by-side diff
- Cursor-like WebView diff with floating Undo/Keep actions

## Screenshots

💥 **New in 0.4.0. Cursor like floating accept/reject buttons!**
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

- Activity Bar **Change Recording** tree with file grouping
- Recording mode (start/stop) with workspace baseline snapshot
- Workspace-wide file watching (including external file changes)
- Inline readonly diff view with line and word-level highlights
- Side-by-side diff (`Original ↔ Current`) via built-in VS Code diff
- Cursor-like WebView diff (Split/Unified, Wrap, Expand, Keep All, Reject All)
- Block-wise actions: Undo/Keep per change block
- File-level actions: Revert file, Revert all files, Keep all changes in file
- Deleted-line badge, CodeLens actions, and hover details
- Settings panel + Watch Ignore editor (`.gitignore` style patterns)

## Usage

1. Open **Diff Tracker** from the Activity Bar.
2. Click **Start Recording**.
3. Edit files in your workspace.
4. In **Change Recording**, click a changed file to open inline diff.
5. Use context menu or editor title buttons to open:
   - Inline Diff (active file)
   - Side-by-Side Diff
   - WebView Diff
6. In WebView Diff, use block-level **Undo/Keep** or file-level **Keep All/Reject All**.
7. Use **Revert File** / **Revert All Changes** as needed.
8. Stop recording when done.

## How It Works

When recording starts, Diff Tracker:
1. Captures baseline snapshots for workspace files (batched)
2. Tracks file/document changes and rebuilds line/block diffs
3. Serves virtual inline/original documents
4. Keeps tree, decorations, CodeLens, and WebView in sync

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
| `diffTracker.watchExclude` | `[]` | Additional watch ignore patterns (`.gitignore` style) |

You can toggle display/highlight settings in the sidebar **Settings** panel, and edit watch ignore patterns via **Edit Watch Ignores**.

## Known Issues

- Pure line-ending-style changes (CRLF/LF only) are currently treated as no logical content change.
- If you find a reproducible diff/render edge case, please open an issue with a minimal file sample.

## Release Notes

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

## License

MIT
