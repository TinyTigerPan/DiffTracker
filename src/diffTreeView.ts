import * as vscode from 'vscode';
import * as path from 'path';
import { DiffTracker, FileDiff } from './diffTracker';

interface DirNode {
    name: string;
    absolutePath?: string;
    childrenDirs: Map<string, DirNode>;
    files: FileDiff[];
}

export class DiffTreeDataProvider implements vscode.TreeDataProvider<TreeItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private diffTracker: DiffTracker) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): Thenable<TreeItem[]> {
        const items: TreeItem[] = [];

        // Root level - show files
        if (!element) {
            const changes = this.diffTracker.getTrackedChanges();
            const config = vscode.workspace.getConfiguration('diffTracker');
            const showFolders = config.get<boolean>('showFolders', true);
            items.push(this.createRecordingItem());

            if (changes.length === 0) {
                const emptyItem = new TreeItem('No changes tracked', vscode.TreeItemCollapsibleState.None);
                emptyItem.description = this.diffTracker.getIsRecording() ? 'Make some edits...' : 'Start recording to track changes';
                return Promise.resolve([...items, emptyItem]);
            }

            const revertButton = new TreeItem('Revert All Changes', vscode.TreeItemCollapsibleState.None);
            revertButton.command = {
                command: 'diffTracker.revertAllChanges',
                title: 'Revert All Changes'
            };
            revertButton.iconPath = new vscode.ThemeIcon('discard');
            revertButton.tooltip = `Restore all ${changes.length} file(s) to original state`;
            revertButton.description = `${changes.length} file(s)`;
            items.push(revertButton);

            const keepButton = new TreeItem('Accept All Changes', vscode.TreeItemCollapsibleState.None);
            keepButton.command = {
                command: 'diffTracker.keepAllChanges',
                title: 'Accept All Changes'
            };
            keepButton.iconPath = new vscode.ThemeIcon('check');
            keepButton.tooltip = `Accept all ${changes.length} file(s) as new baseline`;
            keepButton.description = `${changes.length} file(s)`;
            items.push(keepButton);

            const actionsHeader = new TreeItem('Actions', vscode.TreeItemCollapsibleState.None);
            actionsHeader.tooltip = 'Action shortcuts';
            actionsHeader.iconPath = new vscode.ThemeIcon('tools');
            actionsHeader.description = '';
            items.push(actionsHeader);

            if (!showFolders) {
                items.push(...this.createSortedFileItems(changes));
                return Promise.resolve(items);
            }

            const rootNode: DirNode = {
                name: '',
                childrenDirs: new Map<string, DirNode>(),
                files: []
            };

            for (const change of changes) {
                const relativePath = this.toWorkspaceRelative(change.filePath);
                this.insertFileIntoTree(rootNode, relativePath, change);
            }

            items.push(...this.buildTreeItemsFromNode(rootNode, true));
        } else if (element.children) {
            return Promise.resolve(element.children);
        }

        return Promise.resolve(items);
    }

    private createRecordingItem(): TreeItem {
        const state = this.diffTracker.getBaselineState();

        if (state === 'idle') {
            const item = new TreeItem('Start Recording', vscode.TreeItemCollapsibleState.None);
            item.command = {
                command: 'diffTracker.startRecording',
                title: 'Start Recording'
            };
            item.iconPath = new vscode.ThemeIcon('record');
            item.tooltip = 'Start tracking file changes';
            return item;
        }

        const item = new TreeItem('Recording', vscode.TreeItemCollapsibleState.None);
        item.command = {
            command: 'diffTracker.stopRecording',
            title: 'Stop Recording'
        };
        item.iconPath = state === 'building'
            ? new vscode.ThemeIcon('sync~spin')
            : new vscode.ThemeIcon('circle-filled');
        item.description = state === 'building' ? 'Starting...' : 'On';
        item.tooltip = state === 'building'
            ? 'Recording started. Baseline is initializing...'
            : 'Recording is active. Click to stop recording.';
        return item;
    }

    private createFileItem(fileDiff: FileDiff): TreeItem {
        const displayPath = this.getFileDisplayPath(fileDiff);
        const displayName = fileDiff.isDeleted ? `${displayPath} [Deleted]` : displayPath;
        const item = new TreeItem(displayName, vscode.TreeItemCollapsibleState.None);
        item.filePath = fileDiff.filePath;
        item.isDeleted = fileDiff.isDeleted;
        item.resourceUri = vscode.Uri.file(fileDiff.filePath);
        item.iconPath = vscode.ThemeIcon.File;
        item.tooltip = fileDiff.isDeleted
            ? `${fileDiff.filePath}\nDeleted from disk`
            : fileDiff.filePath;

        // Open with configured default mode
        item.command = {
            command: 'diffTracker.openDiffDefault',
            title: 'Open Diff',
            arguments: [item]
        };

        // Add side-by-side button in context menu
        item.contextValue = 'changedFile';

        return item;
    }

    private getFileDisplayPath(fileDiff: FileDiff): string {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const showFullFilePaths = config.get<boolean>('showFullFilePaths', false);

        if (showFullFilePaths) {
            return this.toWorkspaceRelative(fileDiff.filePath);
        }

        return path.basename(fileDiff.filePath);
    }

    private createSortedFileItems(files: FileDiff[]): TreeItem[] {
        return [...files]
            .sort((a, b) => a.fileName.localeCompare(b.fileName) || a.filePath.localeCompare(b.filePath))
            .map(file => this.createFileItem(file));
    }

    private toWorkspaceRelative(filePath: string): string {
        const uri = vscode.Uri.file(filePath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return path.basename(filePath);
        }

        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        const normalizedRelative = relativePath.split(path.sep).join('/');

        // Avoid collisions across workspace folders in multi-root workspaces.
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length > 1) {
            return `${workspaceFolder.name}/${normalizedRelative}`;
        }

        return normalizedRelative;
    }

    private insertFileIntoTree(rootNode: DirNode, relativePath: string, fileDiff: FileDiff): void {
        const normalized = relativePath.replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);
        if (parts.length === 0) {
            rootNode.files.push(fileDiff);
            return;
        }

        let current = rootNode;
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i];
            let next = current.childrenDirs.get(dirName);
            if (!next) {
                next = {
                    name: dirName,
                    absolutePath: this.getAbsoluteDirPath(fileDiff.filePath, parts, i),
                    childrenDirs: new Map<string, DirNode>(),
                    files: []
                };
                current.childrenDirs.set(dirName, next);
            }
            current = next;
        }

        current.files.push(fileDiff);
    }

    private getAbsoluteDirPath(filePath: string, displayParts: string[], dirIndex: number): string | undefined {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (!workspaceFolder) {
            return undefined;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const relativeParts = path.relative(workspaceFolder.uri.fsPath, filePath)
            .split(path.sep)
            .filter(Boolean);

        if (workspaceFolders.length > 1) {
            if (dirIndex === 0 && displayParts[0] === workspaceFolder.name) {
                return workspaceFolder.uri.fsPath;
            }

            return path.join(workspaceFolder.uri.fsPath, ...relativeParts.slice(0, dirIndex));
        }

        return path.join(workspaceFolder.uri.fsPath, ...relativeParts.slice(0, dirIndex + 1));
    }

    private buildTreeItemsFromNode(node: DirNode, isRoot = false): TreeItem[] {
        const items: TreeItem[] = [];

        const sortedDirNames = [...node.childrenDirs.keys()].sort((a, b) => a.localeCompare(b));
        for (const dirName of sortedDirNames) {
            const childNode = node.childrenDirs.get(dirName);
            if (!childNode) {
                continue;
            }

            const dirItem = new TreeItem(childNode.name, vscode.TreeItemCollapsibleState.Expanded);
            dirItem.iconPath = new vscode.ThemeIcon('folder');
            dirItem.children = this.buildTreeItemsFromNode(childNode);
            dirItem.folderFilePaths = this.getFilePathsInNode(childNode);
            dirItem.folderPath = childNode.absolutePath;
            dirItem.description = `${dirItem.folderFilePaths.length} file(s)`;
            dirItem.contextValue = 'changedFolder';
            items.push(dirItem);
        }

        items.push(...this.createSortedFileItems(node.files));

        if (isRoot) {
            return items;
        }

        return items;
    }

    private getFilePathsInNode(node: DirNode): string[] {
        const filePaths = node.files.map(file => file.filePath);
        for (const childNode of node.childrenDirs.values()) {
            filePaths.push(...this.getFilePathsInNode(childNode));
        }
        return filePaths;
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

}

class TreeItem extends vscode.TreeItem {
    public children?: TreeItem[];
    public filePath?: string;
    public folderFilePaths?: string[];
    public folderPath?: string;
    public isDeleted?: boolean;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}
