import * as vscode from 'vscode';
import { DiffTracker, TrackChangesEvent } from './diffTracker';

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private diffTracker: DiffTracker) {
        this.diffTracker.onDidTrackChanges((event: TrackChangesEvent) => {
            if (!event.fullRefresh && !event.baselineChanged) {
                return;
            }

            const uris = new Set<string>();
            const fireUri = (filePath: string): void => {
                const uri = vscode.Uri.file(filePath).with({ scheme: 'diff-tracker-original' });
                const key = uri.toString();
                if (uris.has(key)) {
                    return;
                }
                uris.add(key);
                this._onDidChange.fire(uri);
            };

            if (event.fullRefresh) {
                vscode.workspace.textDocuments
                    .filter(doc => doc.uri.scheme === 'diff-tracker-original')
                    .forEach(doc => {
                        const key = doc.uri.toString();
                        if (uris.has(key)) {
                            return;
                        }
                        uris.add(key);
                        this._onDidChange.fire(doc.uri);
                    });

                this.diffTracker.getTrackedChanges().forEach(change => {
                    fireUri(change.filePath);
                });
                return;
            }

            const affectedFiles = new Set<string>([
                ...event.changedFiles,
                ...event.removedFiles
            ]);
            affectedFiles.forEach(filePath => {
                fireUri(filePath);
            });
        });
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        // URI format: diff-tracker-original:///<file-path>
        const filePath = uri.fsPath || decodeURIComponent(uri.path);

        // Get original content from snapshots
        const originalContent = this.diffTracker.getOriginalContent(filePath);
        if (originalContent !== undefined) {
            return originalContent;
        }

        return '// Original content not available';
    }

    public dispose() {
        this._onDidChange.dispose();
    }
}
