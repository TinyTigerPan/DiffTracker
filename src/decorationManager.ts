import * as vscode from 'vscode';
import * as Diff from 'diff';
import { DiffTracker } from './diffTracker';
import { toTrackedFilePath } from './utils/inlineDiffUri';

export class DecorationManager {
    private addedDecorationType: vscode.TextEditorDecorationType;
    private deletedDecorationType: vscode.TextEditorDecorationType;
    private modifiedDecorationType: vscode.TextEditorDecorationType;
    private deletedBadgeDecorationType: vscode.TextEditorDecorationType;
    private wordAddedDecorationType: vscode.TextEditorDecorationType;
    private wordRemovedDecorationType: vscode.TextEditorDecorationType;

    constructor(private diffTracker: DiffTracker) {
        // Green background for added lines (lighter shade)
        this.addedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(63, 185, 80, 0.12)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(63, 185, 80, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            gutterIconPath: this.createGutterIcon('+', '#3fb950'),
            gutterIconSize: 'contain'
        });

        // Red background for deleted lines (lighter shade)
        this.deletedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(248, 81, 73, 0.12)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(248, 81, 73, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            gutterIconPath: this.createGutterIcon('-', '#f85149'),
            gutterIconSize: 'contain'
        });

        // Yellow background for modified lines
        this.modifiedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(187, 128, 9, 0.25)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(187, 128, 9, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            gutterIconPath: this.createGutterIcon('~', '#bb8009'),
            gutterIconSize: 'contain'
        });

        this.deletedBadgeDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                color: '#f85149',
                backgroundColor: 'rgba(248, 81, 73, 0.18)',
                fontStyle: 'italic',
                textDecoration: 'none; margin-left: 12px; padding: 0 6px; border-radius: 3px;'
            }
        });

        // Word-level highlighting for inline diff view
        this.wordAddedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(63, 185, 80, 0.4)',
            borderRadius: '2px'
        });

        this.wordRemovedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(248, 81, 73, 0.4)',
            borderRadius: '2px'
        });
    }

    private createGutterIcon(symbol: string, color: string): vscode.Uri {
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
                <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" 
                      font-family="monospace" font-size="14" font-weight="bold" fill="${color}">
                    ${symbol}
                </text>
            </svg>
        `;
        return vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
    }

    public updateDecorations(editor: vscode.TextEditor) {
        if (!this.diffTracker.getIsRecording()) {
            this.clearDecorations(editor);
            return;
        }

        if (this.isEditorInDiffView(editor)) {
            this.clearDecorations(editor);
            return;
        }

        if (editor.document.uri.scheme === 'diff-tracker-inline') {
            this.updateInlineDecorations(editor);
            return;
        }

        const filePath = editor.document.uri.fsPath;
        if (this.diffTracker.isDocumentOutOfSyncWithTrackedChange(editor.document)) {
            this.clearDecorations(editor);
            return;
        }

        const lineChanges = this.diffTracker.getLineChanges(filePath);

        if (!lineChanges) {
            this.clearDecorations(editor);
            return;
        }

        // Read settings
        const config = vscode.workspace.getConfiguration('diffTracker');
        const showDeletedBadge = config.get<boolean>('showDeletedLinesBadge', true);
        const highlightAdded = config.get<boolean>('highlightAddedLines', true);
        const highlightModified = config.get<boolean>('highlightModifiedLines', true);
        const highlightWordChanges = config.get<boolean>('highlightWordChanges', true);

        const addedRanges: vscode.Range[] = [];
        const modifiedRanges: vscode.Range[] = [];
        const deletedBadgeRanges: vscode.DecorationOptions[] = [];

        // Build a mapping from originalLineNumber to currentLineNumber for non-deleted lines
        const origToCurrentMap = new Map<number, number>();
        let maxOriginalLine = 0;

        lineChanges.forEach(change => {
            if (change.type !== 'deleted' && change.originalLineNumber !== undefined) {
                origToCurrentMap.set(change.originalLineNumber, change.lineNumber);
                maxOriginalLine = Math.max(maxOriginalLine, change.originalLineNumber);
            }
        });

        // Group consecutive deleted lines by their originalLineNumber
        const deletedGroups: Array<{ originalLines: number[]; }> = [];
        let currentGroup: number[] = [];

        const deletedChanges = lineChanges.filter(c => c.type === 'deleted');
        deletedChanges.sort((a, b) => (a.originalLineNumber || 0) - (b.originalLineNumber || 0));

        deletedChanges.forEach(change => {
            const origLine = change.originalLineNumber || 0;
            if (currentGroup.length === 0) {
                currentGroup.push(origLine);
            } else {
                const lastLine = currentGroup[currentGroup.length - 1];
                if (origLine === lastLine + 1) {
                    // Consecutive
                    currentGroup.push(origLine);
                } else {
                    // Start new group
                    deletedGroups.push({ originalLines: currentGroup });
                    currentGroup = [origLine];
                }
            }
        });
        if (currentGroup.length > 0) {
            deletedGroups.push({ originalLines: currentGroup });
        }

        // For each deleted group, find the anchor line in current document
        deletedGroups.forEach(group => {
            const firstDeletedOrigLine = group.originalLines[0];
            const count = group.originalLines.length;

            // Find the closest preceding line that exists in current document
            let anchorCurrentLine = 0;
            for (let searchOrig = firstDeletedOrigLine - 1; searchOrig >= 1; searchOrig--) {
                if (origToCurrentMap.has(searchOrig)) {
                    anchorCurrentLine = origToCurrentMap.get(searchOrig)!;
                    break;
                }
            }

            // If no preceding line found (deletion at start), anchor to line 1
            if (anchorCurrentLine === 0 && editor.document.lineCount > 0) {
                anchorCurrentLine = 1;
            }

            // Ensure anchor is within bounds
            if (anchorCurrentLine > 0 && anchorCurrentLine <= editor.document.lineCount) {
                const lineIndex = anchorCurrentLine - 1;
                const line = editor.document.lineAt(lineIndex);
                const label = count === 1 ? '- 1 line deleted' : `- ${count} lines deleted`;

                deletedBadgeRanges.push({
                    range: new vscode.Range(line.range.end, line.range.end),
                    renderOptions: {
                        after: {
                            contentText: label
                        }
                    }
                });
            }
        });

        const wordAddedRanges: vscode.Range[] = [];

        lineChanges.forEach(change => {
            const line = change.lineNumber - 1;
            if (line < 0 || line >= editor.document.lineCount) {
                return;
            }

            const lineText = editor.document.lineAt(line).text;
            const range = new vscode.Range(line, 0, line, lineText.length);

            switch (change.type) {
                case 'added':
                    if (highlightAdded) {
                        addedRanges.push(range);
                    }
                    break;
                case 'modified':
                    if (highlightModified) {
                        modifiedRanges.push(range);

                        // Add word-level highlighting for modified lines
                        if (highlightWordChanges && change.oldText !== undefined && change.newText !== undefined) {
                            const wordDiff = Diff.diffWordsWithSpace(change.oldText, change.newText);
                            let col = 0;

                            for (const part of wordDiff) {
                                const len = part.value.length;
                                if (part.added) {
                                    // Highlight added words in current line
                                    wordAddedRanges.push(new vscode.Range(line, col, line, col + len));
                                    col += len;
                                } else if (part.removed) {
                                    // Removed words don't appear in current line, skip
                                } else {
                                    // Unchanged text
                                    col += len;
                                }
                            }
                        }
                    }
                    break;
            }
        });

        editor.setDecorations(this.addedDecorationType, addedRanges);
        editor.setDecorations(this.modifiedDecorationType, modifiedRanges);
        editor.setDecorations(this.deletedDecorationType, []);
        editor.setDecorations(this.deletedBadgeDecorationType, showDeletedBadge ? deletedBadgeRanges : []);
        editor.setDecorations(this.wordAddedDecorationType, wordAddedRanges);

    }

    public clearDecorations(editor: vscode.TextEditor) {
        editor.setDecorations(this.addedDecorationType, []);
        editor.setDecorations(this.deletedDecorationType, []);
        editor.setDecorations(this.modifiedDecorationType, []);
        editor.setDecorations(this.deletedBadgeDecorationType, []);
        editor.setDecorations(this.wordAddedDecorationType, []);
        editor.setDecorations(this.wordRemovedDecorationType, []);
    }

    public clearAllDecorations() {
        vscode.window.visibleTextEditors.forEach(editor => {
            this.clearDecorations(editor);
        });
    }

    public dispose() {
        this.addedDecorationType.dispose();
        this.deletedDecorationType.dispose();
        this.modifiedDecorationType.dispose();
        this.deletedBadgeDecorationType.dispose();
        this.wordAddedDecorationType.dispose();
        this.wordRemovedDecorationType.dispose();
    }

    private updateInlineDecorations(editor: vscode.TextEditor) {
        const filePath = toTrackedFilePath(editor.document.uri.fsPath);

        let inlineView = this.diffTracker.getInlineView(filePath);
        if (!inlineView) {
            const tracked = this.diffTracker.getTrackedChanges().find(change => change.filePath === filePath);
            if (tracked) {
                inlineView = this.diffTracker.buildInlineViewFromContents(
                    tracked.originalContent,
                    tracked.currentContent
                );
            }
        }
        if (!inlineView) {
            this.clearDecorations(editor);
            return;
        }
        const lineTypes = inlineView.lineTypes;
        const inlineContent = inlineView.content;

        const config = vscode.workspace.getConfiguration('diffTracker');
        const highlightWordChanges = config.get<boolean>('highlightWordChanges', true);

        const inlineLines = inlineContent.split('\n');
        const addedRanges: vscode.Range[] = [];
        const deletedRanges: vscode.Range[] = [];
        const wordAddedRanges: vscode.Range[] = [];
        const wordRemovedRanges: vscode.Range[] = [];
        const lineCount = editor.document.lineCount;
        const total = Math.min(lineTypes.length, lineCount);

        let i = 0;
        while (i < total) {
            const type = lineTypes[i];

            // Check for consecutive deleted lines followed by consecutive added lines
            if (type === 'deleted') {
                // Collect all consecutive deleted lines
                const deletedStart = i;
                while (i < total && lineTypes[i] === 'deleted') {
                    i++;
                }
                const deletedEnd = i;
                const deletedCount = deletedEnd - deletedStart;

                // Collect all consecutive added lines that follow
                const addedStart = i;
                while (i < total && lineTypes[i] === 'added') {
                    i++;
                }
                const addedEnd = i;
                const addedCount = addedEnd - addedStart;

                // Pair deleted and added lines by position for word-level diff
                const pairCount = Math.min(deletedCount, addedCount);
                for (let j = 0; j < pairCount; j++) {
                    const deletedLineIdx = deletedStart + j;
                    const addedLineIdx = addedStart + j;
                    const oldLine = inlineLines[deletedLineIdx] || '';
                    const newLine = inlineLines[addedLineIdx] || '';

                    // Add line-level decorations
                    const deletedLineText = editor.document.lineAt(deletedLineIdx).text;
                    const addedLineText = editor.document.lineAt(addedLineIdx).text;
                    deletedRanges.push(new vscode.Range(deletedLineIdx, 0, deletedLineIdx, deletedLineText.length));
                    addedRanges.push(new vscode.Range(addedLineIdx, 0, addedLineIdx, addedLineText.length));

                    // Compute word-level diff (if enabled)
                    if (highlightWordChanges) {
                        const wordDiff = Diff.diffWordsWithSpace(oldLine, newLine);

                        let oldCol = 0;
                        let newCol = 0;

                        for (const part of wordDiff) {
                            const len = part.value.length;
                            if (part.removed) {
                                wordRemovedRanges.push(new vscode.Range(deletedLineIdx, oldCol, deletedLineIdx, oldCol + len));
                                oldCol += len;
                            } else if (part.added) {
                                wordAddedRanges.push(new vscode.Range(addedLineIdx, newCol, addedLineIdx, newCol + len));
                                newCol += len;
                            } else {
                                oldCol += len;
                                newCol += len;
                            }
                        }
                    }
                }

                // Remaining unpaired deleted lines (line-level only)
                for (let j = pairCount; j < deletedCount; j++) {
                    const lineIdx = deletedStart + j;
                    const deletedLineText = editor.document.lineAt(lineIdx).text;
                    deletedRanges.push(new vscode.Range(lineIdx, 0, lineIdx, deletedLineText.length));
                }

                // Remaining unpaired added lines (line-level only)
                for (let j = pairCount; j < addedCount; j++) {
                    const lineIdx = addedStart + j;
                    const addedLineText = editor.document.lineAt(lineIdx).text;
                    addedRanges.push(new vscode.Range(lineIdx, 0, lineIdx, addedLineText.length));
                }

                continue;
            }

            if (type === 'added') {
                const lineText = editor.document.lineAt(i).text;
                addedRanges.push(new vscode.Range(i, 0, i, lineText.length));
            }
            i++;
        }

        editor.setDecorations(this.addedDecorationType, addedRanges);
        editor.setDecorations(this.deletedDecorationType, deletedRanges);
        editor.setDecorations(this.modifiedDecorationType, []);
        editor.setDecorations(this.wordAddedDecorationType, wordAddedRanges);
        editor.setDecorations(this.wordRemovedDecorationType, wordRemovedRanges);
    }

    private isEditorInDiffView(editor: vscode.TextEditor): boolean {
        const targetUri = editor.document.uri.toString();
        for (const group of vscode.window.tabGroups.all) {
            const activeTab = group.activeTab;
            if (!activeTab) {
                continue;
            }

            const input = activeTab.input;
            if (!(input instanceof vscode.TabInputTextDiff)) {
                continue;
            }

            if (input.original.toString() === targetUri || input.modified.toString() === targetUri) {
                return true;
            }
        }

        return false;
    }
}
