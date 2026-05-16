import * as vscode from 'vscode';
import { ChangeBlock, DiffTracker, TrackChangesEvent } from './diffTracker';

type WebviewChangeBlockPayload = {
    blockId: string;
    blockIndex: number;
    startLine: number;
    endLine: number;
    type: 'added' | 'modified' | 'deleted';
    originalStartLine: number;
    originalEndLine: number;
    currentLineNumbers: number[];
    originalLineNumbers: number[];
};

type WebviewInboundMessage = {
    command: string;
    requestId?: string;
    filePath?: string;
    blockIndex?: number;
    lineNumber?: number;
    hunkIndex?: number;
    changeBlockIndex?: number;
    changeBlockId?: string;
    style?: string;
    wrap?: boolean;
    expandAll?: boolean;
};

/**
 * Manages a WebviewPanel for displaying diffs using @pierre/diffs library
 */
export class WebviewDiffPanel {
    public static currentPanel: WebviewDiffPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private filePath: string = '';
    private currentStyle: 'split' | 'unified';
    private currentWrap: boolean = false;
    private currentExpandAll: boolean = false;
    private isInitialized: boolean = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private diffTracker: DiffTracker
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.currentStyle = WebviewDiffPanel.getDefaultStyle();

        // Listen for panel disposal
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Listen for theme changes
        this.disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => {
                this.updateTheme();
            })
        );

        // Listen for messages from webview
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );

        // Auto-refresh when diff changes (file edited, saved, etc.)
        this.disposables.push(
            this.diffTracker.onDidTrackChanges((event: TrackChangesEvent) => {
                if (!this.filePath) {
                    return;
                }

                if (event.fullRefresh) {
                    this.update(this.filePath);
                    return;
                }

                const affectedFiles = new Set<string>([
                    ...event.changedFiles,
                    ...event.removedFiles
                ]);
                if (affectedFiles.has(this.filePath)) {
                    this.update(this.filePath);
                }
            })
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        diffTracker: DiffTracker,
        filePath: string,
        revealColumn?: vscode.ViewColumn
    ): WebviewDiffPanel {
        const column = revealColumn ?? WebviewDiffPanel.getDefaultRevealColumn();

        // If panel exists and showing the same file, reveal it
        if (WebviewDiffPanel.currentPanel && WebviewDiffPanel.currentPanel.filePath === filePath) {
            WebviewDiffPanel.currentPanel.panel.reveal(column);
            return WebviewDiffPanel.currentPanel;
        }

        // If panel exists but for a different file, update it
        if (WebviewDiffPanel.currentPanel) {
            WebviewDiffPanel.currentPanel.update(filePath);
            WebviewDiffPanel.currentPanel.panel.reveal(column);
            return WebviewDiffPanel.currentPanel;
        }

        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            'diffTrackerWebview',
            'Diff View',
            column ?? vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'out'),
                    vscode.Uri.joinPath(extensionUri, 'resources'),
                    vscode.Uri.joinPath(extensionUri, 'webview')
                ]
            }
        );

        WebviewDiffPanel.currentPanel = new WebviewDiffPanel(panel, extensionUri, diffTracker);
        WebviewDiffPanel.currentPanel.update(filePath);
        return WebviewDiffPanel.currentPanel;
    }

    private static getDefaultRevealColumn(): vscode.ViewColumn {
        const openBeside = vscode.workspace.getConfiguration('diffTracker').get<boolean>('openWebviewBeside', false);
        if (openBeside) {
            return vscode.ViewColumn.Beside;
        }

        return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    }

    private static getDefaultStyle(): 'split' | 'unified' {
        const defaultSplit = vscode.workspace.getConfiguration('diffTracker').get<boolean>('webviewDefaultSplit', true);
        return defaultSplit ? 'split' : 'unified';
    }

    public update(filePath: string): void {
        this.filePath = filePath;
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'file';
        this.panel.title = `Diff: ${fileName}`;

        if (this.isInitialized) {
            // Send incremental update instead of regenerating HTML
            this.sendDataUpdate();
        } else {
            this.panel.webview.html = this.getHtmlContent();
            this.isInitialized = true;
        }
    }

    private sendDataUpdate(): void {
        const trackedChanges = this.diffTracker.getTrackedChanges();
        const fileChange = trackedChanges.find(c => c.filePath === this.filePath);
        const originalContent =
            fileChange?.originalContent ??
            this.diffTracker.getOriginalContent(this.filePath) ??
            '';
        const currentContent = fileChange?.currentContent ?? originalContent;
        const logicalOriginalContent = this.toLogicalDiffContent(originalContent);
        const logicalCurrentContent = this.toLogicalDiffContent(currentContent);
        const changeBlocks = this.diffTracker.getChangeBlocks(this.filePath).map(block => this.serializeChangeBlock(block));
        const fileName = this.filePath.split('/').pop() || this.filePath.split('\\').pop() || 'file';
        const lang = this.getLangForFileName(fileName);

        this.panel.webview.postMessage({
            command: 'updateData',
            filePath: this.filePath,
            fileName,
            lang,
            oldContents: logicalOriginalContent,
            newContents: logicalCurrentContent,
            changeBlocks,
            style: this.currentStyle,
            wrap: this.currentWrap,
            expandAll: this.currentExpandAll
        });
    }

    private async handleMessage(message: WebviewInboundMessage): Promise<void> {
        switch (message.command) {
            case 'revertBlock':
                if (message.filePath && (message.changeBlockId !== undefined || message.changeBlockIndex !== undefined)) {
                    try {
                        const success = await vscode.commands.executeCommand<boolean>(
                            'diffTracker.revertBlock',
                            message.filePath,
                            message.changeBlockId ?? message.changeBlockIndex
                        );
                        this.postActionAck(message.requestId, success !== false);
                    } catch (error) {
                        this.postActionAck(message.requestId, false, error);
                    }
                }
                break;
            case 'keepBlock':
                if (message.filePath && (message.changeBlockId !== undefined || message.changeBlockIndex !== undefined)) {
                    try {
                        const success = await vscode.commands.executeCommand<boolean>(
                            'diffTracker.keepBlock',
                            message.filePath,
                            message.changeBlockId ?? message.changeBlockIndex
                        );
                        this.postActionAck(message.requestId, success !== false);
                    } catch (error) {
                        this.postActionAck(message.requestId, false, error);
                    }
                }
                break;
            case 'keepAll':
                if (message.filePath) {
                    try {
                        const success = await vscode.commands.executeCommand<boolean>(
                            'diffTracker.keepAllBlocksInFile',
                            message.filePath
                        );
                        this.postActionAck(message.requestId, success !== false);
                    } catch (error) {
                        this.postActionAck(message.requestId, false, error);
                    }
                }
                break;
            case 'revertAll':
                if (message.filePath) {
                    try {
                        const result = await vscode.commands.executeCommand<boolean | 'cancelled'>(
                            'diffTracker.revertAllBlocksInFile',
                            message.filePath
                        );
                        if (result === 'cancelled') {
                            this.postActionAck(message.requestId, true, undefined, true);
                        } else {
                            this.postActionAck(message.requestId, result !== false);
                        }
                    } catch (error) {
                        this.postActionAck(message.requestId, false, error);
                    }
                }
                break;
            case 'setStyle':
                if (message.style === 'split' || message.style === 'unified') {
                    this.currentStyle = message.style;
                }
                break;
            case 'setWrap':
                if (typeof message.wrap === 'boolean') {
                    this.currentWrap = message.wrap;
                }
                break;
            case 'setExpandAll':
                if (typeof message.expandAll === 'boolean') {
                    this.currentExpandAll = message.expandAll;
                }
                break;
        }
    }

    private postActionAck(requestId: string | undefined, ok: boolean, error?: unknown, cancelled = false): void {
        if (!requestId) {
            return;
        }

        this.panel.webview.postMessage({
            command: 'actionAck',
            requestId,
            ok,
            cancelled,
            error: ok ? undefined : (error instanceof Error ? error.message : String(error ?? 'Unknown error'))
        });
    }

    private updateTheme(): void {
        const themeKind = vscode.window.activeColorTheme.kind;
        const themeType = themeKind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
        this.panel.webview.postMessage({ command: 'setTheme', themeType });
    }

    private getLangForFileName(fileName: string): string {
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const langMap: Record<string, string> = {
            'ts': 'typescript',
            'tsx': 'tsx',
            'js': 'javascript',
            'jsx': 'jsx',
            'py': 'python',
            'rs': 'rust',
            'go': 'go',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'h': 'c',
            'hpp': 'cpp',
            'css': 'css',
            'scss': 'scss',
            'html': 'html',
            'json': 'json',
            'md': 'markdown',
            'yaml': 'yaml',
            'yml': 'yaml',
            'xml': 'xml',
            'sql': 'sql',
            'sh': 'bash',
            'bash': 'bash',
            'zsh': 'bash',
            'zig': 'zig',
        };
        return langMap[ext] || 'plaintext';
    }

    private getHtmlContent(): string {
        const webview = this.panel.webview;
        const originalContent = this.diffTracker.getOriginalContent(this.filePath) || '';
        const trackedChanges = this.diffTracker.getTrackedChanges();
        const fileChange = trackedChanges.find(c => c.filePath === this.filePath);
        const currentContent = fileChange?.currentContent ?? originalContent;
        const logicalOriginalContent = this.toLogicalDiffContent(originalContent);
        const logicalCurrentContent = this.toLogicalDiffContent(currentContent);
        const fileName = this.filePath.split('/').pop() || this.filePath.split('\\').pop() || 'file';
        const escapedFileName = this.escapeHtml(fileName);

        // Get change blocks from diffTracker - this is the source of truth for block indexing
        const changeBlocks = this.diffTracker.getChangeBlocks(this.filePath).map(block => this.serializeChangeBlock(block));

        // Detect language from file extension
        const lang = this.getLangForFileName(fileName);

        // Determine initial theme
        const themeKind = vscode.window.activeColorTheme.kind;
        const initialThemeType = themeKind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
        const serializedFilePath = this.serializeForInlineScript(this.filePath);
        const serializedFileName = this.serializeForInlineScript(fileName);
        const serializedOriginalContent = this.serializeForInlineScript(logicalOriginalContent);
        const serializedCurrentContent = this.serializeForInlineScript(logicalCurrentContent);
        const serializedLang = this.serializeForInlineScript(lang);
        const serializedChangeBlocks = this.serializeForInlineScript(changeBlocks);
        const serializedInitialStyle = this.serializeForInlineScript(this.currentStyle);
        const serializedInitialWrap = this.serializeForInlineScript(this.currentWrap);
        const serializedInitialExpandAll = this.serializeForInlineScript(this.currentExpandAll);
        const diffsBundleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'webview', 'diffs-bundle.js')
        );
        const cspSource = webview.cspSource;

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource}; font-src ${cspSource};">
    <title>Diff View</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .toolbar {
            display: flex;
            gap: 8px;
            padding: 8px 12px;
            background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
            border-bottom: 1px solid var(--vscode-editorGroup-border, #444);
            flex-shrink: 0;
        }
        .toolbar button {
            padding: 4px 12px;
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #fff);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 12px;
        }
        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .toolbar button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .toolbar button.secondary {
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ccc);
        }
        .toolbar button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .toolbar .btn-keep-all {
            background: #238636;
            color: #fff;
            border: 1px solid #238636;
        }
        .toolbar .btn-keep-all:hover {
            background: #2ea043;
        }
        .toolbar .btn-reject-all {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
            color: #fff;
            border: 1px solid var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .toolbar .btn-reject-all:hover {
            background: var(--vscode-button-secondaryHoverBackground, #4f5359);
        }
        .toolbar .spacer {
            flex: 1;
        }
        .toolbar .filename {
            font-size: 13px;
            font-weight: 500;
            color: var(--vscode-foreground, #ccc);
            align-self: center;
        }
        #diff-scroll-shell {
            flex: 1;
            display: flex;
            min-height: 0;
            min-width: 0;
        }
        #diff-container {
            flex: 1;
            overflow: auto;
            padding: 0;
            padding-bottom: 28px;
            min-width: 0;
        }
        #diff-overview-ruler {
            position: relative;
            flex: 0 0 10px;
            width: 10px;
            background: rgba(127, 127, 127, 0.08);
            border-left: 1px solid var(--vscode-editorGroup-border, #444);
        }
        #diff-overview-ruler.is-empty {
            opacity: 0;
            pointer-events: none;
        }
        .overview-viewport {
            position: absolute;
            left: 1px;
            right: 1px;
            top: 0;
            height: 100%;
            border: 1px solid rgba(127, 127, 127, 0.42);
            background: rgba(127, 127, 127, 0.1);
            pointer-events: none;
            z-index: 1;
        }
        .overview-marker {
            position: absolute;
            left: 1px;
            right: 1px;
            min-height: 4px;
            padding: 0;
            border: 0;
            border-radius: 1px;
            cursor: pointer;
            z-index: 2;
            appearance: none;
        }
        .overview-marker[data-change-type="added"] {
            background: #2ea043;
        }
        .overview-marker[data-change-type="deleted"] {
            background: #f85149;
        }
        .overview-marker[data-change-type="modified"] {
            background: linear-gradient(to bottom, #f85149 0 50%, #2ea043 50% 100%);
        }
        .overview-marker:hover {
            filter: brightness(1.25);
        }
        .overview-marker:focus-visible {
            outline: 1px solid var(--vscode-focusBorder, #007fd4);
            outline-offset: 1px;
        }
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground, #888);
        }
        .no-changes {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground, #888);
            flex-direction: column;
            gap: 8px;
        }
        .no-changes svg {
            width: 48px;
            height: 48px;
            opacity: 0.5;
        }
        /* Floating action buttons (Cursor-style) - right side of change block */
        .hunk-actions {
            position: absolute;
            right: 8px;
            top: 0;
            display: flex;
            gap: 4px;
            z-index: 10;
        }
        .hunk-actions button {
            padding: 1px 6px;
            font-size: 11px;
            border: 1px solid rgba(255,255,255,0.3);
            border-radius: 3px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.15s;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            line-height: 1.2;
            height: 18px;
        }
        .hunk-actions button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .hunk-actions.is-busy button {
            pointer-events: none;
        }
        .hunk-actions .btn-revert {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-color: var(--vscode-button-secondaryBackground);
        }
        .hunk-actions .btn-revert:hover {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
            color: var(--vscode-button-secondaryForeground);
        }
        .hunk-actions .btn-keep {
            background: #238636;
            color: #fff;
            border-color: #238636;
        }
        .hunk-actions .btn-keep:hover {
            background: #2ea043;
        }
        .hunk-actions .shortcut {
            opacity: 0.7;
            font-size: 9px;
            padding-left: 2px;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <span class="filename">${escapedFileName}</span>
        <div class="spacer"></div>
        <button id="btn-split" class="secondary">Split</button>
        <button id="btn-unified" class="secondary">Unified</button>
        <button id="btn-wrap" class="secondary">Wrap</button>
        <button id="btn-expand" class="secondary">Expand</button>
        <button id="btn-keep-all" class="btn-keep-all">Keep All</button>
        <button id="btn-reject-all" class="btn-reject-all">Reject All</button>
    </div>
    <div id="diff-scroll-shell">
        <div id="diff-container">
            <div class="loading">Loading diff...</div>
        </div>
        <div id="diff-overview-ruler" class="is-empty" aria-label="Diff overview">
            <div id="diff-overview-viewport" class="overview-viewport"></div>
        </div>
    </div>

    <script src="${diffsBundleUri}"></script>
    <script>
        const { FileDiff, parseDiffFromFile } = window.PierreDiffs || {};
        if (!FileDiff || !parseDiffFromFile) {
            throw new Error('Failed to load local @pierre/diffs bundle.'); 
        }

        const vscode = acquireVsCodeApi();
        const container = document.getElementById('diff-container');
        const overviewRuler = document.getElementById('diff-overview-ruler');
        const overviewViewport = document.getElementById('diff-overview-viewport');
        const btnSplit = document.getElementById('btn-split');
        const btnUnified = document.getElementById('btn-unified');
        const btnWrap = document.getElementById('btn-wrap');
        const btnExpand = document.getElementById('btn-expand');
        const btnKeepAll = document.getElementById('btn-keep-all');
        const btnRejectAll = document.getElementById('btn-reject-all');

        let filePath = ${serializedFilePath};

        const oldFile = {
            name: ${serializedFileName},
            contents: ${serializedOriginalContent},
            lang: ${serializedLang}
        };

        const newFile = {
            name: ${serializedFileName},
            contents: ${serializedCurrentContent},
            lang: ${serializedLang}
        };

        // Change blocks from diffTracker - source of truth for indexing
        let changeBlocks = ${serializedChangeBlocks};

        let currentStyle = ${serializedInitialStyle};
        let currentWrap = ${serializedInitialWrap};
        let currentExpandAll = ${serializedInitialExpandAll};
        let fileDiffInstance = null;
        let fileDiffMeta = null;
        let pendingMutationRequestId = null;
        let pendingGlobalActionRequestId = null;
        let waitingForRefresh = false;
        let requestSequence = 0;
        let overviewRulerUpdateFrame = 0;
        const pendingBlockActions = new Set();
        const pendingRequests = new Map();

        const DEBUG_BLOCK_ANNOTATION = false;
        const DEBUG_ACTION_FLOW = false;

        function debugBlockAnnotation(message, data) {
            if (!DEBUG_BLOCK_ANNOTATION) {
                return;
            }
            console.debug('[diff-tracker][block-annotation]', message, data);
        }

        function debugActionFlow(message, data) {
            if (!DEBUG_ACTION_FLOW) {
                return;
            }
            console.debug('[diff-tracker][action-flow]', message, data);
        }

        function createRequestId(command, blockId) {
            requestSequence += 1;
            return command + ':' + (blockId || 'global') + ':' + Date.now() + ':' + requestSequence;
        }

        function isMutationLocked() {
            return pendingMutationRequestId !== null || waitingForRefresh;
        }

        function setToolbarButtonsDisabled(disabled) {
            btnKeepAll.disabled = disabled;
            btnRejectAll.disabled = disabled;
        }

        function updateToolbarMutationState() {
            setToolbarButtonsDisabled(isMutationLocked());
        }

        function setBlockWrapperBusy(wrapper, busy) {
            if (!wrapper) {
                return;
            }
            wrapper.classList.toggle('is-busy', busy);
            const buttons = wrapper.querySelectorAll('button');
            buttons.forEach(button => {
                button.disabled = busy;
            });
        }

        function beginMutation(requestId, meta) {
            pendingMutationRequestId = requestId;
            pendingRequests.set(requestId, meta);
            if (meta.scope === 'block' && meta.blockId) {
                pendingBlockActions.add(meta.blockId);
            }
            if (meta.scope === 'global') {
                pendingGlobalActionRequestId = requestId;
            }
            updateToolbarMutationState();
            debugActionFlow('begin', {
                requestId,
                ...meta,
                changeBlocks: changeBlocks.length
            });
        }

        function toPositiveInt(value) {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                return undefined;
            }
            const int = Math.trunc(num);
            return int > 0 ? int : undefined;
        }

        function uniqueSortedPositiveNumbers(values) {
            if (!Array.isArray(values)) {
                return [];
            }
            const unique = new Set();
            values.forEach(value => {
                const int = toPositiveInt(value);
                if (int !== undefined) {
                    unique.add(int);
                }
            });
            return [...unique].sort((a, b) => a - b);
        }

        function clampLineNumber(lineNumber, totalLines) {
            if (totalLines <= 0) {
                return 1;
            }
            const normalized = toPositiveInt(lineNumber) ?? 1;
            return Math.max(1, Math.min(normalized, totalLines));
        }

        function getSideLineCount(diffMeta, side) {
            const lines = side === 'additions' ? diffMeta?.newLines : diffMeta?.oldLines;
            return Array.isArray(lines) ? lines.length : 0;
        }

        function getHunkSideRange(hunk, side, sideLineCount) {
            if (!hunk || sideLineCount <= 0) {
                return undefined;
            }
            const start = toPositiveInt(side === 'additions' ? hunk.additionStart : hunk.deletionStart);
            const count = toPositiveInt(side === 'additions' ? hunk.additionCount : hunk.deletionCount);
            if (start === undefined || count === undefined) {
                return undefined;
            }
            const end = start + count - 1;
            if (end < 1 || start > sideLineCount) {
                return undefined;
            }
            return {
                start: clampLineNumber(start, sideLineCount),
                end: clampLineNumber(end, sideLineCount)
            };
        }

        function findHunkForBlock(block, diffMeta, side) {
            if (!diffMeta || !Array.isArray(diffMeta.hunks) || diffMeta.hunks.length === 0) {
                return undefined;
            }

            const rangeStart = toPositiveInt(
                side === 'additions'
                    ? block.startLine
                    : (block.originalStartLine ?? block.originalEndLine)
            );
            const rangeEnd = toPositiveInt(
                side === 'additions'
                    ? block.endLine
                    : (block.originalEndLine ?? block.originalStartLine)
            ) ?? rangeStart;

            if (rangeStart === undefined || rangeEnd === undefined) {
                return undefined;
            }

            return diffMeta.hunks.find(hunk => {
                const start = toPositiveInt(side === 'additions' ? hunk.additionStart : hunk.deletionStart);
                const count = toPositiveInt(side === 'additions' ? hunk.additionCount : hunk.deletionCount);
                if (start === undefined || count === undefined) {
                    return false;
                }
                const end = start + count - 1;
                return rangeStart <= end && rangeEnd >= start;
            });
        }

        function resolveBlockAnnotation(block, diffMeta) {
            if (!block || typeof block.blockId !== 'string') {
                return undefined;
            }

            const side = block.type === 'deleted' ? 'deletions' : 'additions';
            const currentLineNumbers = uniqueSortedPositiveNumbers(block.currentLineNumbers);
            const originalLineNumbers = uniqueSortedPositiveNumbers(block.originalLineNumbers);

            if (side === 'additions') {
                if (currentLineNumbers.length > 0) {
                    return {
                        side,
                        lineNumber: currentLineNumbers[currentLineNumbers.length - 1],
                        strategy: 'block.currentLineNumbers.last'
                    };
                }

                const fallbackLine = toPositiveInt(block.endLine) ?? toPositiveInt(block.startLine) ?? 1;
                return {
                    side,
                    lineNumber: fallbackLine,
                    strategy: 'block.endLine'
                };
            }

            if (originalLineNumbers.length > 0) {
                return {
                    side,
                    lineNumber: originalLineNumbers[originalLineNumbers.length - 1],
                    strategy: 'block.originalLineNumbers.last'
                };
            }

            const fallbackLine = toPositiveInt(block.originalEndLine)
                ?? toPositiveInt(block.originalStartLine)
                ?? 1;
            return {
                side,
                lineNumber: fallbackLine,
                strategy: 'block.originalEndLine'
            };
        }

        function validateAnnotationTarget(annotation, block, diffMeta) {
            if (!annotation) {
                return undefined;
            }

            const sideLineCount = getSideLineCount(diffMeta, annotation.side);
            if (sideLineCount <= 0) {
                return undefined;
            }

            const target = toPositiveInt(annotation.lineNumber);
            if (target !== undefined && target <= sideLineCount) {
                return {
                    ...annotation,
                    lineNumber: target,
                    strategy: annotation.strategy + ' -> direct'
                };
            }

            const hunk = findHunkForBlock(block, diffMeta, annotation.side);
            const hunkRange = getHunkSideRange(hunk, annotation.side, sideLineCount);
            if (hunkRange) {
                const base = target ?? hunkRange.end;
                const lineNumber = Math.max(hunkRange.start, Math.min(base, hunkRange.end));
                return {
                    ...annotation,
                    lineNumber,
                    strategy: annotation.strategy + ' -> hunk-range'
                };
            }

            const candidates = annotation.side === 'additions'
                ? uniqueSortedPositiveNumbers(block.currentLineNumbers)
                : uniqueSortedPositiveNumbers(block.originalLineNumbers);
            const inRangeCandidates = candidates.filter(line => line >= 1 && line <= sideLineCount);
            if (inRangeCandidates.length > 0) {
                return {
                    ...annotation,
                    lineNumber: inRangeCandidates[inRangeCandidates.length - 1],
                    strategy: annotation.strategy + ' -> block-candidate'
                };
            }

            return {
                ...annotation,
                lineNumber: clampLineNumber(target ?? 1, sideLineCount),
                strategy: annotation.strategy + ' -> global-clamp'
            };
        }

        // Create annotations based on diffTracker blocks, not diffs.com ChangeContent
        function getBlockAnnotations(diffMeta) {
            const annotations = [];
            const seenBlockIds = new Set();
            
            changeBlocks.forEach((block) => {
                if (!block || typeof block.blockId !== 'string' || seenBlockIds.has(block.blockId)) {
                    return;
                }
                seenBlockIds.add(block.blockId);

                const resolved = resolveBlockAnnotation(block, diffMeta);
                if (!resolved) {
                    debugBlockAnnotation('resolve failed', { blockId: block.blockId });
                    return;
                }

                const validated = validateAnnotationTarget(resolved, block, diffMeta);
                if (!validated) {
                    debugBlockAnnotation('validate failed', {
                        blockId: block.blockId,
                        resolved
                    });
                    return;
                }

                debugBlockAnnotation('resolved', {
                    blockId: block.blockId,
                    resolved,
                    validated
                });

                annotations.push({
                    side: validated.side,
                    lineNumber: validated.lineNumber,
                    metadata: { 
                        blockId: block.blockId,
                        blockIndex: block.blockIndex,
                        strategy: validated.strategy
                    }
                });
            });
            
            return annotations;
        }

        function sendBlockMutation(command, blockId, wrapper) {
            if (!blockId || isMutationLocked()) {
                return;
            }

            const requestId = createRequestId(command, blockId);
            beginMutation(requestId, { scope: 'block', blockId, command });
            setBlockWrapperBusy(wrapper, true);

            vscode.postMessage({
                command,
                filePath: filePath,
                changeBlockId: blockId,
                requestId
            });
        }

        function sendGlobalMutation(command) {
            if (isMutationLocked()) {
                return;
            }

            const requestId = createRequestId(command, 'global');
            beginMutation(requestId, { scope: 'global', command });

            vscode.postMessage({
                command,
                filePath: filePath,
                requestId
            });
        }

        function getChangeBlockById(blockId) {
            if (typeof blockId !== 'string') {
                return undefined;
            }

            return changeBlocks.find(block => block && block.blockId === blockId);
        }

        function getBlockAnchor(blockId) {
            const anchors = container.querySelectorAll('.hunk-actions[data-change-block-id]');
            for (const anchor of anchors) {
                if (anchor.dataset.changeBlockId === blockId) {
                    return anchor;
                }
            }

            return undefined;
        }

        function clearOverviewRuler() {
            overviewRuler.replaceChildren(overviewViewport);
            overviewRuler.classList.add('is-empty');
            syncOverviewViewport();
        }

        function syncOverviewViewport() {
            const rulerHeight = overviewRuler.clientHeight;
            if (rulerHeight <= 0) {
                return;
            }

            const scrollHeight = container.scrollHeight;
            const viewportHeight = container.clientHeight;
            if (scrollHeight <= 0 || viewportHeight <= 0 || scrollHeight <= viewportHeight) {
                overviewViewport.style.top = '0px';
                overviewViewport.style.height = rulerHeight + 'px';
                return;
            }

            const viewportIndicatorHeight = Math.max(12, Math.round((viewportHeight / scrollHeight) * rulerHeight));
            const maxIndicatorTop = Math.max(0, rulerHeight - viewportIndicatorHeight);
            const indicatorTop = Math.min(
                maxIndicatorTop,
                Math.round((container.scrollTop / scrollHeight) * rulerHeight)
            );

            overviewViewport.style.top = indicatorTop + 'px';
            overviewViewport.style.height = viewportIndicatorHeight + 'px';
        }

        function scrollToChangeBlock(blockId) {
            const anchor = getBlockAnchor(blockId);
            if (!anchor) {
                return;
            }

            const containerRect = container.getBoundingClientRect();
            const anchorRect = anchor.getBoundingClientRect();
            const targetTop = anchorRect.top - containerRect.top + container.scrollTop - 24;
            container.scrollTo({
                top: Math.max(0, targetTop),
                behavior: 'smooth'
            });
        }

        function createOverviewMarker(block, top, height) {
            if (!block || (block.type !== 'added' && block.type !== 'deleted' && block.type !== 'modified')) {
                return undefined;
            }

            const marker = document.createElement('button');
            marker.type = 'button';
            marker.className = 'overview-marker';
            marker.dataset.changeBlockId = block.blockId;
            marker.dataset.changeType = block.type;
            marker.style.top = top + 'px';
            marker.style.height = height + 'px';

            const blockNumber = Number.isFinite(block.blockIndex) ? block.blockIndex + 1 : '?';
            const label = 'Go to ' + block.type + ' change block ' + blockNumber;
            marker.title = label;
            marker.setAttribute('aria-label', label);
            marker.addEventListener('click', () => scrollToChangeBlock(block.blockId));
            marker.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    scrollToChangeBlock(block.blockId);
                }
            });

            return marker;
        }

        function renderOverviewRuler() {
            overviewRulerUpdateFrame = 0;
            clearOverviewRuler();

            if (!Array.isArray(changeBlocks) || changeBlocks.length === 0) {
                return;
            }

            const rulerHeight = overviewRuler.clientHeight;
            const scrollHeight = container.scrollHeight;
            if (rulerHeight <= 0 || scrollHeight <= 0) {
                return;
            }

            const containerRect = container.getBoundingClientRect();
            const markerHeight = 4;
            const maxMarkerTop = Math.max(0, rulerHeight - markerHeight);
            const fragment = document.createDocumentFragment();
            let markerCount = 0;

            changeBlocks.forEach(block => {
                if (!block || typeof block.blockId !== 'string') {
                    return;
                }

                const blockData = getChangeBlockById(block.blockId);
                const anchor = getBlockAnchor(block.blockId);
                if (!blockData || !anchor) {
                    return;
                }

                const anchorRect = anchor.getBoundingClientRect();
                const anchorTop = anchorRect.top - containerRect.top + container.scrollTop;
                const markerTop = Math.max(0, Math.min(maxMarkerTop, Math.round((anchorTop / scrollHeight) * rulerHeight)));
                const marker = createOverviewMarker(blockData, markerTop, markerHeight);
                if (marker) {
                    fragment.appendChild(marker);
                    markerCount++;
                }
            });

            overviewRuler.appendChild(fragment);
            overviewRuler.classList.toggle('is-empty', markerCount === 0);
            syncOverviewViewport();
        }

        function scheduleOverviewRulerUpdate() {
            if (overviewRulerUpdateFrame !== 0) {
                return;
            }

            overviewRulerUpdateFrame = requestAnimationFrame(renderOverviewRuler);
        }

        function createHunkActionButtons(blockId, blockIndex) {
            const wrapper = document.createElement('div');
            wrapper.className = 'hunk-actions';
            wrapper.dataset.changeBlockId = blockId;
            wrapper.dataset.changeBlockIndex = String(blockIndex);
            
            const revertBtn = document.createElement('button');
            revertBtn.className = 'btn-revert';
            revertBtn.innerHTML = 'Undo <span class="shortcut">⌘N</span>';
            revertBtn.title = 'Revert this change (block ' + (blockIndex + 1) + ')';
            revertBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendBlockMutation('revertBlock', blockId, wrapper);
            });

            const keepBtn = document.createElement('button');
            keepBtn.className = 'btn-keep';
            keepBtn.innerHTML = 'Keep <span class="shortcut">⌘Y</span>';
            keepBtn.title = 'Accept this change (block ' + (blockIndex + 1) + ')';
            keepBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendBlockMutation('keepBlock', blockId, wrapper);
            });

            wrapper.appendChild(revertBtn);
            wrapper.appendChild(keepBtn);
            if (isMutationLocked() || pendingBlockActions.has(blockId)) {
                setBlockWrapperBusy(wrapper, true);
            }
            return wrapper;
        }

        function renderDiff(style) {
            currentStyle = style;
            container.innerHTML = '';

            // Check for no changes: both content identical AND no change blocks
            const hasContentDiff = oldFile.contents !== newFile.contents;
            const hasBlocks = changeBlocks.length > 0;
            
            if (!hasContentDiff && !hasBlocks) {
                container.innerHTML = '<div class="no-changes"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg><span>No changes detected</span></div>';
                clearOverviewRuler();
                updateToolbarMutationState();
                return;
            }

            fileDiffMeta = parseDiffFromFile(oldFile, newFile);
            
            // Use diffTracker blocks for annotations
            const blockAnnotations = getBlockAnnotations(fileDiffMeta);
            
            const annotationsToRender = blockAnnotations;

            fileDiffInstance = new FileDiff({
                theme: { dark: 'github-dark', light: 'github-light' },
                themeType: '${initialThemeType}',
                diffStyle: style,
                diffIndicators: 'bars',
                lineDiffType: 'word-alt',
                hunkSeparators: 'line-info',
                overflow: currentWrap ? 'wrap' : 'scroll',
                unsafeCSS: '[data-code]{ padding-bottom: calc(1lh + var(--diffs-gap-block, 8px)) !important; } [data-annotation-content]{ overflow: visible !important; } [data-line]{ position: relative; }',
                expandUnchanged: currentExpandAll,
                disableFileHeader: true,
                renderAnnotation(annotation) {
                    return createHunkActionButtons(annotation.metadata.blockId, annotation.metadata.blockIndex);
                }
            });

            fileDiffInstance.render({
                fileDiff: fileDiffMeta,
                lineAnnotations: annotationsToRender,
                containerWrapper: container,
            });

            btnSplit.classList.toggle('secondary', style !== 'split');
            btnUnified.classList.toggle('secondary', style !== 'unified');
            btnWrap.classList.toggle('secondary', !currentWrap);
            btnExpand.classList.toggle('secondary', !currentExpandAll);
            updateToolbarMutationState();
            scheduleOverviewRulerUpdate();
        }

        btnSplit.addEventListener('click', () => {
            renderDiff('split');
            vscode.postMessage({ command: 'setStyle', style: 'split' });
        });
        btnUnified.addEventListener('click', () => {
            renderDiff('unified');
            vscode.postMessage({ command: 'setStyle', style: 'unified' });
        });
        btnWrap.addEventListener('click', () => {
            currentWrap = !currentWrap;
            renderDiff(currentStyle);
            vscode.postMessage({ command: 'setWrap', wrap: currentWrap });
        });
        btnExpand.addEventListener('click', () => {
            currentExpandAll = !currentExpandAll;
            renderDiff(currentStyle);
            vscode.postMessage({ command: 'setExpandAll', expandAll: currentExpandAll });
        });
        btnKeepAll.addEventListener('click', () => {
            sendGlobalMutation('keepAll');
        });
        btnRejectAll.addEventListener('click', () => {
            sendGlobalMutation('revertAll');
        });
        container.addEventListener('scroll', syncOverviewViewport);
        window.addEventListener('resize', scheduleOverviewRulerUpdate);

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'setTheme' && fileDiffInstance) {
                fileDiffInstance.setThemeType(message.themeType);
                scheduleOverviewRulerUpdate();
            } else if (message.command === 'actionAck') {
                const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
                if (!requestId) {
                    return;
                }

                const requestMeta = pendingRequests.get(requestId);
                if (!requestMeta) {
                    debugActionFlow('ack-stale', { requestId });
                    return;
                }

                pendingRequests.delete(requestId);
                if (pendingMutationRequestId === requestId) {
                    pendingMutationRequestId = null;
                }
                if (requestMeta.scope === 'block' && requestMeta.blockId) {
                    pendingBlockActions.delete(requestMeta.blockId);
                }
                if (requestMeta.scope === 'global' && pendingGlobalActionRequestId === requestId) {
                    pendingGlobalActionRequestId = null;
                }

                const ok = message.ok !== false;
                const cancelled = message.cancelled === true;
                debugActionFlow('ack', {
                    requestId,
                    ok,
                    cancelled,
                    requestMeta,
                    error: message.error
                });

                if (cancelled) {
                    waitingForRefresh = false;
                    updateToolbarMutationState();
                    renderDiff(currentStyle);
                    return;
                }

                if (!ok) {
                    waitingForRefresh = false;
                    updateToolbarMutationState();
                    const errorMessage = typeof message.error === 'string' ? message.error : 'Unknown error';
                    console.warn('[diff-tracker] action failed', { requestId, error: errorMessage });
                    renderDiff(currentStyle);
                    return;
                }

                // Keep controls locked until updateData arrives so stale actions cannot fire.
                waitingForRefresh = true;
                updateToolbarMutationState();
            } else if (message.command === 'updateData') {
                // Update data and re-render with current style
                if (typeof message.filePath === 'string') {
                    filePath = message.filePath;
                }
                if (typeof message.fileName === 'string') {
                    oldFile.name = message.fileName;
                    newFile.name = message.fileName;
                }
                if (typeof message.lang === 'string') {
                    oldFile.lang = message.lang;
                    newFile.lang = message.lang;
                }
                oldFile.contents = message.oldContents;
                newFile.contents = message.newContents;
                // Replace array reference atomically to avoid race conditions
                changeBlocks = message.changeBlocks.slice();
                if (typeof message.wrap === 'boolean') {
                    currentWrap = message.wrap;
                }
                if (typeof message.expandAll === 'boolean') {
                    currentExpandAll = message.expandAll;
                }
                waitingForRefresh = false;
                pendingMutationRequestId = null;
                pendingGlobalActionRequestId = null;
                pendingRequests.clear();
                pendingBlockActions.clear();
                renderDiff(currentStyle);
            }
        });

        // Initial render
        renderDiff(currentStyle);
    </script>
</body>
</html>`;
    }

    private toLogicalDiffContent(content: string): string {
        const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (normalized.length === 0) {
            return '';
        }

        const hasFinalEol = normalized.endsWith('\n');
        const split = normalized.split('\n');
        const lines = hasFinalEol ? split.slice(0, -1) : split;
        return lines.join('\n');
    }

    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private serializeForInlineScript(value: unknown): string {
        return JSON.stringify(value)
            .replace(/</g, '\\u003C')
            .replace(/>/g, '\\u003E')
            .replace(/&/g, '\\u0026')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    private getOriginalRangeForBlock(block: { changes: Array<{ originalLineNumber?: number }> }): { startLine: number; endLine: number } {
        const lines = block.changes
            .map(change => change.originalLineNumber)
            .filter((n): n is number => n !== undefined)
            .sort((a, b) => a - b);

        if (lines.length === 0) {
            return { startLine: 0, endLine: 0 };
        }

        return { startLine: lines[0], endLine: lines[lines.length - 1] };
    }

    private serializeChangeBlock(block: ChangeBlock): WebviewChangeBlockPayload {
        const originalRange = this.getOriginalRangeForBlock(block);
        const currentLineNumbers = [...new Set(
            block.changes
                .map(change => change.lineNumber)
                .filter(lineNumber => Number.isFinite(lineNumber) && lineNumber > 0)
        )].sort((a, b) => a - b);
        const originalLineNumbers = [...new Set(
            block.changes
                .map(change => change.originalLineNumber)
                .filter((lineNumber): lineNumber is number => lineNumber !== undefined && Number.isFinite(lineNumber) && lineNumber > 0)
        )].sort((a, b) => a - b);

        return {
            originalStartLine: originalRange.startLine,
            originalEndLine: originalRange.endLine,
            blockId: block.blockId,
            startLine: block.startLine,
            endLine: block.endLine,
            type: block.type,
            blockIndex: block.blockIndex,
            currentLineNumbers,
            originalLineNumbers
        };
    }

    public dispose(): void {
        WebviewDiffPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
