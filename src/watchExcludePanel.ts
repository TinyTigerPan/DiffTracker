import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';

export class WatchExcludePanel {
    public static currentPanel: WatchExcludePanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private diffTracker: DiffTracker) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async message => this.handleMessage(message),
            null,
            this.disposables
        );

        this.panel.webview.html = this.getHtmlContent();
    }

    public static createOrShow(extensionUri: vscode.Uri, diffTracker: DiffTracker): WatchExcludePanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (WatchExcludePanel.currentPanel) {
            WatchExcludePanel.currentPanel.panel.reveal(column);
            return WatchExcludePanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'diffTrackerWatchExcludes',
            'Diff Tracker: Watch Ignores',
            column ?? vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        WatchExcludePanel.currentPanel = new WatchExcludePanel(panel, extensionUri, diffTracker);
        return WatchExcludePanel.currentPanel;
    }

    private async handleMessage(message: { command: string; patterns?: string[]; testPath?: string }) {
        if (message.command === 'save' && Array.isArray(message.patterns)) {
            const config = vscode.workspace.getConfiguration('diffTracker');
            await config.update('watchExclude', message.patterns, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Diff Tracker: Watch ignore rules saved');
            await this.postCurrentPatterns();
            return;
        }

        if (message.command === 'reload') {
            await this.postCurrentPatterns();
        }

        if (message.command === 'testPath') {
            const result = this.diffTracker.testIgnorePath(message.testPath);
            this.panel.webview.postMessage({
                command: 'testResult',
                ...result
            });
        }
    }

    private async postCurrentPatterns(): Promise<void> {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const patterns = config.get<string[]>('watchExclude', []);
        this.panel.webview.postMessage({ command: 'setPatterns', patterns });
    }

    private getHtmlContent(): string {
        const webview = this.panel.webview;
        const cspSource = webview.cspSource;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'webview', 'watchExcludePanel.js')
        );

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src ${cspSource};">
    <title>Watch Ignores</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
        }
        h1 {
            font-size: 14px;
            margin: 0 0 8px 0;
            font-weight: 600;
        }
        p {
            margin: 0 0 12px 0;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .test-hint {
            margin: 12px 0 6px 0;
        }
        ul {
            margin: 0 0 12px 16px;
            padding: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        li {
            margin: 2px 0;
        }
        textarea {
            width: 100%;
            min-height: 240px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            box-sizing: border-box;
        }
        .actions {
            margin-top: 12px;
            display: flex;
            gap: 8px;
        }
        .test {
            margin-top: 16px;
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .test input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px 8px;
            font-size: 12px;
        }
        .test span {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 2px;
            font-size: 12px;
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
    </style>
</head>
<body>
    <h1>Watch ignore patterns</h1>
    <p>Rules are applied in this order when their matching settings are enabled:</p>
    <ul>
        <li>.gitignore files (including nested ones)</li>
        <li>Built-in defaults (.git, node_modules, out, dist, build, coverage, tmp)</li>
        <li>VS Code excludes (files.exclude by default; search.exclude and files.watcherExclude only when enabled)</li>
        <li>VS Code conditional exclude objects are ignored</li>
        <li>Patterns below (one per line, gitignore-style)</li>
    </ul>
    <textarea id="patterns" spellcheck="false"></textarea>
    <div class="actions">
        <button id="save">Save</button>
        <button id="reload" class="secondary">Reload</button>
    </div>
    <p class="test-hint">Test a path against the current saved rules.</p>
    <div class="test">
        <input id="test-path" type="text" placeholder="Test path, e.g. src/app.ts" />
        <button id="test-btn" class="secondary">Test</button>
        <span id="test-result"></span>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose(): void {
        WatchExcludePanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
