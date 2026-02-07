import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';
import { DecorationManager } from './decorationManager';
import { DiffTreeDataProvider } from './diffTreeView';
import { DiffHoverProvider } from './hoverProvider';
import { StatusBarManager } from './statusBarManager';
import { OriginalContentProvider } from './originalContentProvider';
import { InlineContentProvider } from './inlineContentProvider';
import { DiffCodeLensProvider } from './codeLensProvider';
import { SettingsTreeDataProvider } from './settingsTreeView';
import { WebviewDiffPanel } from './webviewDiffPanel';
import { WatchExcludePanel } from './watchExcludePanel';
import { createInlineDiffUri } from './utils/inlineDiffUri';

let diffTracker: DiffTracker;
let decorationManager: DecorationManager;
let statusBarManager: StatusBarManager;
let originalContentProvider: OriginalContentProvider;
let inlineContentProvider: InlineContentProvider;
let codeLensProvider: DiffCodeLensProvider;
let settingsTreeDataProvider: SettingsTreeDataProvider;
let changesTreeView: vscode.TreeView<any> | undefined;

type DefaultOpenMode = 'webview' | 'inline' | 'sideBySide' | 'original' | 'splitOriginalWebview';

function extractFilePath(filePathOrItem: string | any): string | undefined {
    return typeof filePathOrItem === 'string'
        ? filePathOrItem
        : filePathOrItem?.filePath;
}

function getDefaultOpenMode(): DefaultOpenMode {
    const config = vscode.workspace.getConfiguration('diffTracker');
    const mode = config.get<string>('defaultOpenMode', 'webview');
    if (mode === 'inline' || mode === 'sideBySide' || mode === 'original' || mode === 'splitOriginalWebview' || mode === 'webview') {
        return mode;
    }
    return 'webview';
}

export function activate(context: vscode.ExtensionContext) {

    // Initialize services
    diffTracker = new DiffTracker();
    decorationManager = new DecorationManager(diffTracker);
    statusBarManager = new StatusBarManager(diffTracker);
    originalContentProvider = new OriginalContentProvider(diffTracker);
    inlineContentProvider = new InlineContentProvider(diffTracker);
    codeLensProvider = new DiffCodeLensProvider(diffTracker);
    settingsTreeDataProvider = new SettingsTreeDataProvider();

    // Register tree view provider for activity bar
    const treeDataProvider = new DiffTreeDataProvider(diffTracker);
    changesTreeView = vscode.window.createTreeView('diffTracker.changesView', {
        treeDataProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(changesTreeView);

    // Register settings tree view
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('diffTracker.settingsView', settingsTreeDataProvider)
    );

    const refreshChangesTree = () => {
        treeDataProvider.refresh();

        if (!changesTreeView) {
            return;
        }

        const count = diffTracker.getTrackedChanges().length;
        if (count > 0) {
            changesTreeView.badge = {
                value: count,
                tooltip: `${count} changed file(s)`
            };
        } else {
            changesTreeView.badge = undefined;
        }
    };

    // Register toggle setting command
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.toggleSetting', async (settingKey: string) => {
            await settingsTreeDataProvider.toggleSetting(settingKey);
            // Refresh decorations after setting change
            vscode.window.visibleTextEditors.forEach(editor => {
                decorationManager.updateDecorations(editor);
            });
            codeLensProvider.refresh();
        })
    );

    // Register hover provider to show diff details
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('*', new DiffHoverProvider(diffTracker))
    );

    // Register CodeLens provider for block-wise actions
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('*', codeLensProvider)
    );

    // Register virtual document provider for original content
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('diff-tracker-original', originalContentProvider)
    );

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('diff-tracker-inline', inlineContentProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.toggleRecording', () => {
            if (diffTracker.getIsRecording()) {
                diffTracker.stopRecording();
                vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', false);
                refreshChangesTree();
                decorationManager.clearAllDecorations();
            } else {
                diffTracker.startRecording();
                vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', true);
                refreshChangesTree();

                // Update decorations for current editor
                if (vscode.window.activeTextEditor) {
                    decorationManager.updateDecorations(vscode.window.activeTextEditor);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.startRecording', () => {
            diffTracker.startRecording();
            vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', true);
            refreshChangesTree();

            // Update decorations for current editor
            if (vscode.window.activeTextEditor) {
                decorationManager.updateDecorations(vscode.window.activeTextEditor);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.stopRecording', () => {
            diffTracker.stopRecording();
            vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', false);
            refreshChangesTree();
            decorationManager.clearAllDecorations();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showInlineDiff', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            const inlineUri = createInlineDiffUri(filePath);
            const doc = await vscode.workspace.openTextDocument(inlineUri);
            const editor = await vscode.window.showTextDocument(doc);
            decorationManager.updateDecorations(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showSideBySideDiff', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            // Show side-by-side diff using VS Code's built-in diff editor
            const currentUri = vscode.Uri.file(filePath);
            const originalUri = currentUri.with({ scheme: 'diff-tracker-original' });

            const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'file';

            await vscode.commands.executeCommand('vscode.diff',
                originalUri,
                currentUri,
                `Original  ↔  Current: ${fileName}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showSideBySideDiffActive', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                return;
            }

            await vscode.commands.executeCommand('diffTracker.showSideBySideDiff', editor.document.uri.fsPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showDiffs', async () => {
            // Update decorations for current editor
            if (vscode.window.activeTextEditor) {
                decorationManager.updateDecorations(vscode.window.activeTextEditor);
            }
            vscode.window.showInformationMessage('Diff highlighting applied to editor');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertAllChanges', async () => {
            const changes = diffTracker.getTrackedChanges();
            if (changes.length === 0) {
                return;
            }

            // Confirm with user
            const answer = await vscode.window.showWarningMessage(
                `Revert all ${changes.length} file(s) to their original state? This cannot be undone.`,
                { modal: true },
                'Revert All',
                'Cancel'
            );

            if (answer === 'Revert All') {
                const revertedCount = await diffTracker.revertAllChanges();
                refreshChangesTree();
                decorationManager.clearAllDecorations();
                vscode.window.showInformationMessage(`Reverted ${revertedCount} file(s)`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertFile', async (filePathOrItem: string | any) => {
            const filePath = typeof filePathOrItem === 'string'
                ? filePathOrItem
                : filePathOrItem?.filePath;

            if (!filePath) {
                return;
            }

            const answer = await vscode.window.showWarningMessage(
                `Revert changes for ${filePath}? This cannot be undone.`,
                { modal: true },
                'Revert',
                'Cancel'
            );

            if (answer !== 'Revert') {
                return;
            }

            const success = await diffTracker.revertFile(filePath);
            if (success) {
                refreshChangesTree();
                decorationManager.clearAllDecorations();
                vscode.window.showInformationMessage('File reverted to original content');
            }
        })
    );

    // Open the original file (not the diff view)
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.openOriginalFile', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.openDiffDefault', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);
            if (!filePath) {
                return;
            }

            switch (getDefaultOpenMode()) {
                case 'inline':
                    await vscode.commands.executeCommand('diffTracker.showInlineDiff', filePath);
                    break;
                case 'sideBySide':
                    await vscode.commands.executeCommand('diffTracker.showSideBySideDiff', filePath);
                    break;
                case 'original':
                    await vscode.commands.executeCommand('diffTracker.openOriginalFile', filePath);
                    break;
                case 'splitOriginalWebview':
                    await vscode.commands.executeCommand('diffTracker.showOriginalAndWebviewSplit', filePath);
                    break;
                case 'webview':
                default:
                    await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
                    break;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.clearDiffs', () => {
            diffTracker.clearDiffs();
            refreshChangesTree();
            decorationManager.clearAllDecorations();
            vscode.window.showInformationMessage('Diff Tracker: All diffs cleared');
        })
    );

    // Block-wise revert command
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertBlock', async (filePath: string, blockRef: string | number) => {
            const success = await diffTracker.revertBlock(filePath, blockRef);
            if (success) {
                codeLensProvider.refresh();
                refreshChangesTree();
            }
            return success;
        })
    );

    // Block-wise keep command
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.keepBlock', async (filePath: string, blockRef: string | number) => {
            const success = await diffTracker.keepBlock(filePath, blockRef);
            if (success) {
                codeLensProvider.refresh();
                refreshChangesTree();
            }
            return success;
        })
    );

    // Navigate to block
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.goToBlock', async (filePath: string, blockRef: string | number) => {
            const blocks = diffTracker.getChangeBlocks(filePath);
            if (blocks.length === 0) {
                return;
            }

            let block;
            if (typeof blockRef === 'number') {
                if (blockRef < 0 || blockRef >= blocks.length) {
                    return;
                }
                block = blocks[blockRef];
            } else {
                block = blocks.find(item => item.blockId === blockRef);
                if (!block) {
                    return;
                }
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const line = Math.max(0, block.startLine - 1);
            const position = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        })
    );

    // Revert all blocks in a file
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertAllBlocksInFile', async (filePath: string) => {
            const success = await diffTracker.revertFile(filePath);
            if (success) {
                codeLensProvider.refresh();
                refreshChangesTree();
            }
            return success;
        })
    );

    // Keep all blocks in a file (accept all changes)
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.keepAllBlocksInFile', async (filePath: string) => {
            const success = await diffTracker.keepAllChangesInFile(filePath);
            if (success) {
                codeLensProvider.refresh();
                refreshChangesTree();
            }
            return success;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showInlineDiffActive', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                return;
            }

            await vscode.commands.executeCommand('diffTracker.showInlineDiff', editor.document.uri.fsPath);
        })
    );

    // Webview-based diff commands
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showWebviewDiff', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            WebviewDiffPanel.createOrShow(context.extensionUri, diffTracker, filePath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showOriginalAndWebviewSplit', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);
            if (!filePath) {
                return;
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: true,
                preview: false
            });

            WebviewDiffPanel.createOrShow(
                context.extensionUri,
                diffTracker,
                filePath,
                vscode.ViewColumn.Two
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.selectDefaultOpenMode', async () => {
            const config = vscode.workspace.getConfiguration('diffTracker');
            const current = getDefaultOpenMode();
            const items: Array<{ label: string; description: string; value: DefaultOpenMode }> = [
                { label: 'Webview', description: 'Interactive diff panel', value: 'webview' },
                { label: 'Inline (read-only)', description: 'Virtual inline diff document', value: 'inline' },
                { label: 'Side-by-Side', description: 'VS Code built-in diff editor', value: 'sideBySide' },
                { label: 'Original', description: 'Open original file directly', value: 'original' },
                { label: 'Split: Original | Webview', description: 'Left original file, right webview diff', value: 'splitOriginalWebview' }
            ];

            const selected = await vscode.window.showQuickPick(
                items.map(item => ({
                    label: item.value === current ? `$(check) ${item.label}` : item.label,
                    description: item.description,
                    value: item.value
                })),
                { placeHolder: 'Select default open mode when clicking a changed file' }
            );

            if (!selected) {
                return;
            }

            await config.update('defaultOpenMode', selected.value, vscode.ConfigurationTarget.Global);
            settingsTreeDataProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showWebviewDiffActive', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                return;
            }

            WebviewDiffPanel.createOrShow(context.extensionUri, diffTracker, editor.document.uri.fsPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.editWatchExcludes', () => {
            WatchExcludePanel.createOrShow(context.extensionUri, diffTracker);
        })
    );

    // Update decorations when switching editors
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                decorationManager.updateDecorations(editor);
            }
        })
    );

    const updateVisibleDecorations = () => {
        vscode.window.visibleTextEditors.forEach(editor => {
            decorationManager.updateDecorations(editor);
        });
    };

    // Update decorations when recording state changes
    diffTracker.onDidChangeRecordingState(() => {
        refreshChangesTree();
        updateVisibleDecorations();
    });

    // Update decorations when changes are tracked
    diffTracker.onDidTrackChanges(() => {
        refreshChangesTree();
        updateVisibleDecorations();
    });

    refreshChangesTree();

    // Register disposables
    context.subscriptions.push(statusBarManager);
    context.subscriptions.push(originalContentProvider);
}

export function deactivate() {
    if (diffTracker) {
        diffTracker.dispose();
    }
    if (decorationManager) {
        decorationManager.dispose();
    }
    if (statusBarManager) {
        statusBarManager.dispose();
    }
    if (originalContentProvider) {
        originalContentProvider.dispose();
    }
    if (inlineContentProvider) {
        inlineContentProvider.dispose();
    }
    if (codeLensProvider) {
        codeLensProvider.dispose();
    }
}
