import * as vscode from 'vscode';
import { DiffTracker, TrackChangesEvent } from './diffTracker';
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
let diffTreeDataProvider: DiffTreeDataProvider;
let changesTreeView: vscode.TreeView<any> | undefined;

type DefaultOpenMode = 'webview' | 'inline' | 'sideBySide' | 'original' | 'splitOriginalWebview';

function extractFilePath(filePathOrItem: string | any): string | undefined {
    if (typeof filePathOrItem === 'string') {
        return filePathOrItem;
    }

    if (filePathOrItem instanceof vscode.Uri) {
        return filePathOrItem.fsPath;
    }

    return filePathOrItem?.filePath;
}

function extractIsDeleted(filePathOrItem: string | any): boolean | undefined {
    if (!filePathOrItem || typeof filePathOrItem === 'string') {
        return undefined;
    }
    return filePathOrItem?.isDeleted === true;
}

function getDefaultOpenMode(): DefaultOpenMode {
    const config = vscode.workspace.getConfiguration('diffTracker');
    const mode = config.get<string>('defaultOpenMode', 'webview');
    if (mode === 'inline' || mode === 'sideBySide' || mode === 'original' || mode === 'splitOriginalWebview' || mode === 'webview') {
        return mode;
    }
    return 'webview';
}

function getConfirmReversions(): boolean {
    const config = vscode.workspace.getConfiguration('diffTracker');
    return config.get<boolean>('confirmReversions', true);
}

async function confirmWholeFileReversion(message: string, confirmLabel: string): Promise<boolean> {
    if (!getConfirmReversions()) {
        return true;
    }

    const answer = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel,
        'Cancel'
    );

    return answer === confirmLabel;
}

type WholeFileCommandResult = boolean | 'cancelled';

export async function activate(context: vscode.ExtensionContext) {

    // Initialize services
    diffTracker = new DiffTracker(context.storageUri);
    const restoredSession = await diffTracker.restorePersistedState();
    decorationManager = new DecorationManager(diffTracker);
    statusBarManager = new StatusBarManager(diffTracker);
    originalContentProvider = new OriginalContentProvider(diffTracker);
    inlineContentProvider = new InlineContentProvider(diffTracker);
    codeLensProvider = new DiffCodeLensProvider(diffTracker);
    settingsTreeDataProvider = new SettingsTreeDataProvider();

    // Register tree view provider for activity bar
    diffTreeDataProvider = new DiffTreeDataProvider(diffTracker);
    changesTreeView = vscode.window.createTreeView('diffTracker.changesView', {
        treeDataProvider: diffTreeDataProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(changesTreeView);

    // Register settings tree view
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('diffTracker.settingsView', settingsTreeDataProvider)
    );

    const refreshChangesTree = () => {
        diffTreeDataProvider.refresh();

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

    const startRecordingFlow = () => {
        diffTracker.startRecording();
        void vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', true);
    };

    const stopRecordingFlow = () => {
        diffTracker.stopRecording();
        void vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', false);
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

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('diffTracker.showFullFilePaths')) {
                refreshChangesTree();
            }
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
                stopRecordingFlow();
            } else {
                startRecordingFlow();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.startRecording', () => {
            startRecordingFlow();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.stopRecording', () => {
            stopRecordingFlow();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.beginAutomationSession', (target?: unknown) => {
            return diffTracker.beginAutomationSession(target);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.endAutomationSession', (target?: unknown) => {
            diffTracker.endAutomationSession(target);
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

            const confirmed = await confirmWholeFileReversion(
                `Revert all ${changes.length} file(s) to their original state? This cannot be undone.`,
                'Revert All'
            );

            if (!confirmed) {
                return;
            }

            const revertedCount = await diffTracker.revertAllChanges();
            refreshChangesTree();
            decorationManager.clearAllDecorations();
            vscode.window.showInformationMessage(`Reverted ${revertedCount} file(s)`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.keepAllChanges', async () => {
            const changes = diffTracker.getTrackedChanges();
            if (changes.length === 0) {
                return;
            }

            const acceptedCount = await diffTracker.keepAllChanges();
            refreshChangesTree();
            decorationManager.clearAllDecorations();
            vscode.window.showInformationMessage(`Accepted ${acceptedCount} file(s)`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertFile', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            const confirmed = await confirmWholeFileReversion(
                `Revert changes for ${filePath}? This cannot be undone.`,
                'Revert'
            );

            if (!confirmed) {
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

            const deletedFromItem = extractIsDeleted(filePathOrItem);
            const deletedFromTracked = diffTracker.getTrackedChanges().find(change => change.filePath === filePath)?.isDeleted === true;
            const isDeleted = deletedFromItem ?? deletedFromTracked;
            const defaultMode = getDefaultOpenMode();

            if (isDeleted && defaultMode === 'original') {
                await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
                return;
            }

            switch (defaultMode) {
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
        vscode.commands.registerCommand('diffTracker.clearDiffs', async () => {
            if (diffTracker.getIsRecording()) {
                await diffTracker.resetBaselineToCurrentState();
            } else {
                diffTracker.clearDiffs();
            }
            refreshChangesTree();
            decorationManager.clearAllDecorations();
            vscode.window.showInformationMessage('Diff Tracker: Baseline reset to current workspace state');
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
        vscode.commands.registerCommand('diffTracker.revertAllBlocksInFile', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);
            if (!filePath) {
                return false;
            }

            const confirmed = await confirmWholeFileReversion(
                `Revert changes for ${filePath}? This cannot be undone.`,
                'Revert'
            );
            if (!confirmed) {
                return 'cancelled' satisfies WholeFileCommandResult;
            }

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
        vscode.commands.registerCommand('diffTracker.keepAllBlocksInFile', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);
            if (!filePath) {
                return false;
            }

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

    const updateVisibleDecorations = (affectedFiles?: Set<string>) => {
        vscode.window.visibleTextEditors.forEach(editor => {
            if (
                affectedFiles &&
                editor.document.uri.scheme === 'file' &&
                !affectedFiles.has(editor.document.uri.fsPath)
            ) {
                return;
            }
            decorationManager.updateDecorations(editor);
        });
    };

    // Update decorations when changes are tracked
    context.subscriptions.push(
        diffTracker.onDidTrackChanges((event: TrackChangesEvent) => {
            refreshChangesTree();

            if (event.fullRefresh) {
                updateVisibleDecorations();
                return;
            }

            const affectedFiles = new Set<string>([
                ...event.changedFiles,
                ...event.removedFiles
            ]);
            if (affectedFiles.size === 0) {
                return;
            }

            updateVisibleDecorations(affectedFiles);
        })
    );

    context.subscriptions.push(
        diffTracker.onDidChangeBaselineState(() => {
            refreshChangesTree();
        })
    );

    refreshChangesTree();
    await vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', diffTracker.getIsRecording());

    if (restoredSession) {
        updateVisibleDecorations();
    } else {
        startRecordingFlow();
    }

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
    if (settingsTreeDataProvider) {
        settingsTreeDataProvider.dispose();
    }
    if (diffTreeDataProvider) {
        diffTreeDataProvider.dispose();
    }
}
