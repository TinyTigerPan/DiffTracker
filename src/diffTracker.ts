import * as vscode from 'vscode';
import * as Diff from 'diff';
import * as path from 'path';
import * as fs from 'fs';
import ignore, { Ignore } from 'ignore';

export interface FileDiff {
    filePath: string;
    fileName: string;
    originalContent: string;
    currentContent: string;
    isDeleted: boolean;
    changes: Diff.Change[];
    timestamp: Date;
}

export interface LineChange {
    lineNumber: number;  // 1-based line number in current document
    type: 'added' | 'deleted' | 'modified' | 'unchanged';
    originalLineNumber?: number;  // Original line number for reference
    oldText?: string;  // Original text content (for modified/deleted lines)
    newText?: string;  // New text content (for modified lines)
    anchorLineNumber?: number;  // For deleted lines: the line in current doc where badge should show
    segmentId?: number; // Internal segment id to keep block grouping stable across EOF edge cases
}

export type InlineLineType = 'added' | 'deleted' | 'unchanged';

export interface InlineDiffView {
    content: string;
    lineTypes: InlineLineType[];
}

export interface ChangeBlock {
    blockId: string;
    blockIndex: number;
    startLine: number;
    endLine: number;
    type: 'added' | 'modified' | 'deleted';
    changes: LineChange[];
}

export interface TrackChangesEvent {
    changedFiles: string[];
    removedFiles: string[];
    fullRefresh: boolean;
    baselineChanged: boolean;
}

interface PendingRemovedLine {
    text: string;
    normalized: string;
    originalLineNumber: number;
}

interface TextLineModel {
    lines: string[];
    hasFinalEol: boolean;
    dominantEol: '\n' | '\r\n' | '\r';
}

interface AutomationSession {
    id: string;
    filePaths: string[];
    allFiles: boolean;
    timeout: NodeJS.Timeout;
}

interface PersistedTrackerState {
    version: 1;
    isRecording: boolean;
    fileSnapshots: Array<[string, string]>;
    baselineExistingFiles: string[];
}

type CurrentFileState =
    | { kind: 'text'; content: string }
    | { kind: 'missing' }
    | { kind: 'unavailable' };

export class DiffTracker {
    private isRecording = false;
    private fileSnapshots = new Map<string, string>();
    private baselineExistingFiles = new Set<string>();
    private trackedChanges = new Map<string, FileDiff>();
    private trackedChangesVersion = 0;
    private trackedChangesCacheVersion = -1;
    private trackedChangesCache: FileDiff[] = [];
    private lineChanges = new Map<string, LineChange[]>();
    private lineChangesVersionByFile = new Map<string, number>();
    private changeBlocksCache = new Map<string, { version: number; blocks: ChangeBlock[] }>();
    private inlineViews = new Map<string, InlineDiffView>();
    private disposables: vscode.Disposable[] = [];
    private fileWatchers: vscode.FileSystemWatcher[] = [];
    private ignoreMatchers = new Map<string, Ignore>();
    private ignoreResultCache = new Map<string, boolean>();
    private readonly ignoreResultCacheMaxEntries = 5000;
    private gitignoreCache = new Map<string, { files: string[]; mtimeMap: Map<string, number> }>();
    private externalWatcherEnabled = false;
    private snapshotInitialized = false;
    private baselineBuilding = false;
    private pendingExternalChanges = new Set<string>();
    private externalChangeTimers = new Map<string, NodeJS.Timeout>();
    private documentChangeTimers = new Map<string, NodeJS.Timeout>();
    private watcherSuppressionTimers = new Map<string, NodeJS.Timeout>();
    private automationSessions = new Map<string, AutomationSession>();
    private automationFileRefCounts = new Map<string, number>();
    private automationGlobalRefCount = 0;
    private nextAutomationSessionId = 1;
    private persistTimer: NodeJS.Timeout | undefined;
    private persistStateWriteQueue: Promise<void> = Promise.resolve();
    private readonly persistDebounceMs = 300;
    private readonly persistedStateFileName = 'session-state.json';
    private readonly _onDidChangeRecordingState = new vscode.EventEmitter<boolean>();
    private readonly _onDidTrackChanges = new vscode.EventEmitter<TrackChangesEvent>();
    private readonly _onDidChangeBaselineState = new vscode.EventEmitter<'idle' | 'building' | 'ready'>();

    public readonly onDidChangeRecordingState = this._onDidChangeRecordingState.event;
    public readonly onDidTrackChanges = this._onDidTrackChanges.event;
    public readonly onDidChangeBaselineState = this._onDidChangeBaselineState.event;

    constructor(private readonly storageUri?: vscode.Uri) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(this.onDocumentChanged, this)
        );

        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(this.onDocumentOpened, this)
        );

        this.disposables.push(
            vscode.workspace.onWillSaveTextDocument(this.onWillSaveDocument, this)
        );

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(this.onDidSaveDocument, this)
        );

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (
                    e.affectsConfiguration('diffTracker.onlyTrackAutomatedChanges') ||
                    e.affectsConfiguration('diffTracker.onlyTrackVSCodeChanges') ||
                    e.affectsConfiguration('diffTracker.useGitIgnoreExcludes') ||
                    e.affectsConfiguration('diffTracker.useBuiltInExcludes') ||
                    e.affectsConfiguration('diffTracker.useVSCodeExcludes') ||
                    e.affectsConfiguration('diffTracker.watchExclude') ||
                    e.affectsConfiguration('files.watcherExclude') ||
                    e.affectsConfiguration('search.exclude') ||
                    e.affectsConfiguration('files.exclude')
                ) {
                    if (this.isRecording) {
                        this.refreshIgnoreMatchers().catch(() => undefined);
                    }
                }
            })
        );
    }

    public async restorePersistedState(): Promise<boolean> {
        const state = await this.loadPersistedState();
        if (!state) {
            return false;
        }

        if (
            state.isRecording &&
            state.fileSnapshots.length === 0 &&
            (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ) {
            return false;
        }

        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.clearAutomationSessions();
        this.disposeFileWatchers();

        this.isRecording = state.isRecording;
        this.fileSnapshots = new Map(state.fileSnapshots);
        this.baselineExistingFiles = new Set(state.baselineExistingFiles);
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.pendingExternalChanges.clear();
        this.snapshotInitialized = true;
        this.baselineBuilding = false;

        try {
            await this.refreshIgnoreMatchers();
        } catch (error) {
            console.warn('Failed to refresh ignore rules while restoring session state', error);
        }

        await this.rebuildTrackedChangesFromSnapshots();

        if (this.isRecording) {
            await this.startExternalWatchers();
        } else {
            this.externalWatcherEnabled = false;
        }

        return true;
    }

    private shouldTrackOnlyAutomatedChanges(): boolean {
        const config = vscode.workspace.getConfiguration('diffTracker');
        return (
            config.get<boolean>('onlyTrackAutomatedChanges', false) ||
            config.get<boolean>('onlyTrackVSCodeChanges', false)
        );
    }

    public startRecording() {
        const removedFiles = Array.from(this.trackedChanges.keys());
        this.isRecording = true;
        this.clearAutomationSessions();
        this.clearWatcherSuppressionTimers();
        this.fileSnapshots.clear();
        this.baselineExistingFiles.clear();
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.pendingExternalChanges.clear();
        this.snapshotInitialized = false;
        this.baselineBuilding = true;
        this._onDidChangeBaselineState.fire('building');

        vscode.workspace.textDocuments.forEach(doc => {
            this.ensureSnapshotForDocument(doc);
        });

        this.startExternalWatchers();
        this.initializeWorkspaceSnapshots();
        this.schedulePersistState();

        this._onDidChangeRecordingState.fire(true);
        this.emitTrackChangesEvent({
            removedFiles,
            fullRefresh: true,
            baselineChanged: true
        });
    }

    public stopRecording() {
        this.isRecording = false;
        this.baselineBuilding = false;
        this._onDidChangeBaselineState.fire('idle');
        this.clearAutomationSessions();
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.disposeFileWatchers();
        this.resetChangeBlocksCaches();
        this.schedulePersistState();
        this._onDidChangeRecordingState.fire(false);
        this.emitTrackChangesEvent({ fullRefresh: true });
    }

    public clearDiffs() {
        const removedFiles = Array.from(this.trackedChanges.keys());
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.emitTrackChangesEvent({
            removedFiles,
            fullRefresh: true
        });
    }

    public async resetBaselineToCurrentState(): Promise<void> {
        if (!this.isRecording) {
            this.clearDiffs();
            return;
        }

        const removedFiles = Array.from(this.trackedChanges.keys());

        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();

        this.fileSnapshots.clear();
        this.baselineExistingFiles.clear();
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.pendingExternalChanges.clear();
        this.snapshotInitialized = false;
        this.baselineBuilding = true;
        this._onDidChangeBaselineState.fire('building');

        try {
            // Open editors may be ahead of on-disk state; use their in-memory text as baseline.
            vscode.workspace.textDocuments.forEach(doc => {
                this.ensureSnapshotForDocument(doc);
            });

            await this.initializeWorkspaceSnapshots();
        } catch (error) {
            console.error('Failed to reset baseline to current state:', error);
        } finally {
            // Ensure we never leave baseline-building state hanging after failures.
            if (this.isRecording && this.baselineBuilding) {
                this.snapshotInitialized = true;
                this.baselineBuilding = false;
                this._onDidChangeBaselineState.fire('ready');
            }
            this.emitTrackChangesEvent({
                removedFiles,
                fullRefresh: true,
                baselineChanged: true
            });
            this.schedulePersistState();
        }
    }

    private async startExternalWatchers(): Promise<void> {
        this.disposeFileWatchers();
        this.externalWatcherEnabled = false;

        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }

        try {
            await this.refreshIgnoreMatchers();
        } catch (error) {
            console.warn('Failed to build ignore rules for file watcher', error);
        }

        try {
            const patternGlob = '**/*';

            for (const folder of folders) {
                const createWatcher = (glob: string) => {
                    const pattern = new vscode.RelativePattern(folder, glob);
                    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

                    watcher.onDidChange(uri => this.onExternalFileChanged(uri));
                    watcher.onDidCreate(uri => this.onExternalFileCreated(uri));
                    watcher.onDidDelete(uri => this.onExternalFileDeleted(uri));

                    this.fileWatchers.push(watcher);
                };

                createWatcher(patternGlob);
            }

            this.externalWatcherEnabled = true;
        } catch (error: any) {
            this.externalWatcherEnabled = false;
            this.disposeFileWatchers();
            const message = error?.code === 'ENOSPC'
                ? 'Diff Tracker: File watcher limit reached (ENOSPC). Falling back to open files only.'
                : 'Diff Tracker: File watcher failed. Falling back to open files only.';
            vscode.window.showWarningMessage(message);
        }
    }

    private disposeFileWatchers() {
        this.fileWatchers.forEach(w => w.dispose());
        this.fileWatchers = [];
    }

    private clearExternalChangeTimers(): void {
        this.externalChangeTimers.forEach(timer => clearTimeout(timer));
        this.externalChangeTimers.clear();
    }

    private clearDocumentChangeTimers(): void {
        this.documentChangeTimers.forEach(timer => clearTimeout(timer));
        this.documentChangeTimers.clear();
    }

    private clearWatcherSuppressionTimers(): void {
        this.watcherSuppressionTimers.forEach(timer => clearTimeout(timer));
        this.watcherSuppressionTimers.clear();
    }

    private getPersistedStateUri(): vscode.Uri | undefined {
        if (!this.storageUri) {
            return undefined;
        }

        return vscode.Uri.joinPath(this.storageUri, this.persistedStateFileName);
    }

    private buildPersistedState(): PersistedTrackerState | undefined {
        if (!this.storageUri) {
            return undefined;
        }

        if (!this.isRecording && this.fileSnapshots.size === 0) {
            return undefined;
        }

        return {
            version: 1,
            isRecording: this.isRecording,
            fileSnapshots: Array.from(this.fileSnapshots.entries())
                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
            baselineExistingFiles: Array.from(this.baselineExistingFiles.values())
                .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath))
        };
    }

    private schedulePersistState(): void {
        if (!this.storageUri) {
            return;
        }

        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }

        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            void this.flushPersistState();
        }, this.persistDebounceMs);
    }

    private async flushPersistState(): Promise<void> {
        const storageUri = this.storageUri;
        if (!storageUri) {
            return;
        }

        const persistTask = async () => {
            const targetUri = this.getPersistedStateUri();
            if (!targetUri) {
                return;
            }

            const state = this.buildPersistedState();
            if (!state) {
                try {
                    await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: false });
                } catch {
                    // Ignore cleanup errors for missing state files.
                }
                return;
            }

            try {
                await vscode.workspace.fs.createDirectory(storageUri);
                const payload = JSON.stringify(state);
                await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(payload));
            } catch (error) {
                console.error('Failed to persist Diff Tracker session state:', error);
            }
        };

        this.persistStateWriteQueue = this.persistStateWriteQueue.then(persistTask, persistTask);
        await this.persistStateWriteQueue;
    }

    private async loadPersistedState(): Promise<PersistedTrackerState | undefined> {
        const targetUri = this.getPersistedStateUri();
        if (!targetUri) {
            return undefined;
        }

        try {
            const payload = await vscode.workspace.fs.readFile(targetUri);
            const raw = new TextDecoder('utf-8').decode(payload);
            const parsed = JSON.parse(raw) as unknown;
            return this.parsePersistedState(parsed);
        } catch {
            return undefined;
        }
    }

    private parsePersistedState(raw: unknown): PersistedTrackerState | undefined {
        if (!raw || typeof raw !== 'object') {
            return undefined;
        }

        const candidate = raw as {
            version?: unknown;
            isRecording?: unknown;
            fileSnapshots?: unknown;
            baselineExistingFiles?: unknown;
        };

        if (candidate.version !== 1 || typeof candidate.isRecording !== 'boolean') {
            return undefined;
        }

        if (!Array.isArray(candidate.fileSnapshots) || !Array.isArray(candidate.baselineExistingFiles)) {
            return undefined;
        }

        const fileSnapshots: Array<[string, string]> = [];
        for (const entry of candidate.fileSnapshots) {
            if (!Array.isArray(entry) || entry.length !== 2) {
                continue;
            }

            const [filePath, content] = entry;
            if (typeof filePath !== 'string' || typeof content !== 'string') {
                continue;
            }

            fileSnapshots.push([filePath, content]);
        }

        const baselineExistingFiles = candidate.baselineExistingFiles
            .filter((entry): entry is string => typeof entry === 'string');

        return {
            version: 1,
            isRecording: candidate.isRecording,
            fileSnapshots,
            baselineExistingFiles
        };
    }

    private clearAutomationSessions(): void {
        [...this.automationSessions.keys()].forEach(sessionId => this.endAutomationSession(sessionId));
    }

    private scheduleWatcherSuppression(filePath: string, durationMs = 1500): void {
        const existingTimer = this.watcherSuppressionTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.watcherSuppressionTimers.delete(filePath);
        }, durationMs);

        this.watcherSuppressionTimers.set(filePath, timer);
    }

    private shouldSuppressWatcherEvent(filePath: string): boolean {
        return this.watcherSuppressionTimers.has(filePath);
    }

    private onWillSaveDocument(event: vscode.TextDocumentWillSaveEvent): void {
        this.suppressWatcherForVsCodeSave(event.document);
    }

    private onDidSaveDocument(doc: vscode.TextDocument): void {
        this.suppressWatcherForVsCodeSave(doc);
    }

    private suppressWatcherForVsCodeSave(doc: vscode.TextDocument): void {
        if (!this.shouldTrackOnlyAutomatedChanges()) {
            return;
        }

        if (doc.uri.scheme !== 'file') {
            return;
        }

        this.scheduleWatcherSuppression(doc.uri.fsPath);
    }

    private normalizeAutomationFilePath(value: unknown): string | undefined {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }

        if (value instanceof vscode.Uri) {
            return value.fsPath;
        }

        if (typeof value === 'object' && value !== null) {
            const candidate = (value as { filePath?: unknown }).filePath;
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
                return candidate;
            }
        }

        return undefined;
    }

    private normalizeAutomationFilePaths(values: unknown[]): string[] {
        const normalized = new Set<string>();
        values.forEach(value => {
            const filePath = this.normalizeAutomationFilePath(value);
            if (filePath) {
                normalized.add(filePath);
            }
        });
        return [...normalized];
    }

    private parseAutomationSessionTarget(target?: unknown): { filePaths: string[]; ttlMs: number; allFiles: boolean } {
        const defaultTtlMs = 30000;

        if (Array.isArray(target)) {
            const filePaths = this.normalizeAutomationFilePaths(target);
            return {
                filePaths,
                ttlMs: defaultTtlMs,
                allFiles: filePaths.length === 0
            };
        }

        const directFilePath = this.normalizeAutomationFilePath(target);
        if (directFilePath) {
            return {
                filePaths: [directFilePath],
                ttlMs: defaultTtlMs,
                allFiles: false
            };
        }

        if (typeof target === 'object' && target !== null) {
            const payload = target as {
                filePath?: unknown;
                filePaths?: unknown;
                ttlMs?: unknown;
                allFiles?: unknown;
            };
            const filePaths = this.normalizeAutomationFilePaths([
                payload.filePath,
                ...(Array.isArray(payload.filePaths) ? payload.filePaths : [])
            ]);
            const ttlMs = typeof payload.ttlMs === 'number' && Number.isFinite(payload.ttlMs)
                ? Math.max(1000, payload.ttlMs)
                : defaultTtlMs;
            const allFiles = payload.allFiles === true || filePaths.length === 0;
            return { filePaths, ttlMs, allFiles };
        }

        return {
            filePaths: [],
            ttlMs: defaultTtlMs,
            allFiles: true
        };
    }

    private incrementAutomationFileRefs(filePaths: string[]): void {
        filePaths.forEach(filePath => {
            this.automationFileRefCounts.set(filePath, (this.automationFileRefCounts.get(filePath) ?? 0) + 1);
        });
    }

    private decrementAutomationFileRefs(filePaths: string[]): void {
        filePaths.forEach(filePath => {
            const next = (this.automationFileRefCounts.get(filePath) ?? 0) - 1;
            if (next > 0) {
                this.automationFileRefCounts.set(filePath, next);
            } else {
                this.automationFileRefCounts.delete(filePath);
            }
        });
    }

    private isAutomationChangeAllowed(filePath: string): boolean {
        return this.automationGlobalRefCount > 0 || this.automationFileRefCounts.has(filePath);
    }

    public beginAutomationSession(target?: unknown): string {
        const { filePaths, ttlMs, allFiles } = this.parseAutomationSessionTarget(target);
        const sessionId = `automation-${Date.now()}-${this.nextAutomationSessionId++}`;

        if (allFiles) {
            this.automationGlobalRefCount++;
        }
        this.incrementAutomationFileRefs(filePaths);

        const timeout = setTimeout(() => {
            this.endAutomationSession(sessionId);
        }, ttlMs);

        this.automationSessions.set(sessionId, {
            id: sessionId,
            filePaths,
            allFiles,
            timeout
        });

        return sessionId;
    }

    public endAutomationSession(target?: unknown): void {
        if (typeof target === 'string' && this.automationSessions.has(target)) {
            const session = this.automationSessions.get(target);
            if (!session) {
                return;
            }

            clearTimeout(session.timeout);
            if (session.allFiles) {
                this.automationGlobalRefCount = Math.max(0, this.automationGlobalRefCount - 1);
            }
            this.decrementAutomationFileRefs(session.filePaths);
            this.automationSessions.delete(target);
            return;
        }

        if (typeof target === 'object' && target !== null) {
            const sessionId = (target as { sessionId?: unknown }).sessionId;
            if (typeof sessionId === 'string') {
                this.endAutomationSession(sessionId);
                return;
            }
        }

        if (target === undefined) {
            const sessionIds = [...this.automationSessions.keys()];
            sessionIds.forEach(sessionId => this.endAutomationSession(sessionId));
            return;
        }

        const { filePaths, allFiles } = this.parseAutomationSessionTarget(target);
        const sessionIds = [...this.automationSessions.keys()];

        sessionIds.forEach(sessionId => {
            const session = this.automationSessions.get(sessionId);
            if (!session) {
                return;
            }

            const matchesAllFiles = allFiles && session.allFiles;
            const matchesFiles =
                filePaths.length > 0 &&
                filePaths.every(filePath => session.filePaths.includes(filePath));

            if (matchesAllFiles || matchesFiles) {
                this.endAutomationSession(sessionId);
            }
        });
    }

    private async refreshIgnoreMatchers(): Promise<void> {
        this.ignoreMatchers.clear();
        this.ignoreResultCache.clear();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            return;
        }

        for (const folder of folders) {
            const matcher = await this.buildIgnoreMatcher(folder);
            this.ignoreMatchers.set(folder.uri.fsPath, matcher);
        }

        this.pruneIgnoredTrackedChanges();
    }

    private getDefaultExcludePatterns(): string[] {
        return this.getDefaultExcludeDirectoryNames().map(name => `**/${name}/**`);
    }

    private getDefaultExcludeDirectoryNames(): string[] {
        return ['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', 'tmp'];
    }

    private getDefaultExcludeFindFilesPattern(folder: vscode.WorkspaceFolder): vscode.RelativePattern {
        return new vscode.RelativePattern(folder, `**/{${this.getDefaultExcludeDirectoryNames().join(',')}}/**`);
    }

    private shouldUseGitIgnoreExcludes(): boolean {
        const config = vscode.workspace.getConfiguration('diffTracker');
        return config.get<boolean>('useGitIgnoreExcludes', true);
    }

    private shouldUseBuiltInExcludes(): boolean {
        const config = vscode.workspace.getConfiguration('diffTracker');
        return config.get<boolean>('useBuiltInExcludes', true);
    }

    private shouldUseVSCodeExcludes(): boolean {
        const config = vscode.workspace.getConfiguration('diffTracker');
        return config.get<boolean>('useVSCodeExcludes', true);
    }

    private getVsCodeExcludePatterns(): string[] {
        const config = vscode.workspace.getConfiguration();
        const watcherExclude = config.get<Record<string, boolean>>('files.watcherExclude', {});
        const searchExclude = config.get<Record<string, boolean>>('search.exclude', {});
        const filesExclude = config.get<Record<string, boolean>>('files.exclude', {});
        const patterns = new Set<string>();

        const addPatterns = (obj: Record<string, boolean>) => {
            Object.entries(obj).forEach(([pattern, enabled]) => {
                if (enabled) {
                    patterns.add(pattern);
                }
            });
        };

        addPatterns(watcherExclude);
        addPatterns(searchExclude);
        addPatterns(filesExclude);

        return Array.from(patterns);
    }

    private getWatchExcludePatterns(): string[] {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const raw = config.get<string[]>('watchExclude', []) ?? [];
        const ignoreRules: string[] = [];

        raw.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            ignoreRules.push(trimmed);
        });

        return ignoreRules;
    }

    private async buildIgnoreMatcher(folder: vscode.WorkspaceFolder): Promise<Ignore> {
        const ig = ignore();
        const watchExcludes = this.getWatchExcludePatterns();
        const basePatterns = [
            ...(this.shouldUseBuiltInExcludes() ? this.getDefaultExcludePatterns() : []),
            ...(this.shouldUseVSCodeExcludes() ? this.getVsCodeExcludePatterns() : []),
            ...watchExcludes
        ];
        ig.add(basePatterns);

        if (this.shouldUseGitIgnoreExcludes()) {
            const gitignoreFiles = await this.getCachedGitignoreFiles(folder);

            for (const uri of gitignoreFiles) {
                try {
                    const content = await vscode.workspace.fs.readFile(uri);
                    const text = new TextDecoder('utf-8').decode(content);
                    const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
                    const relDir = path.posix.dirname(relPath);
                    const prefix = relDir === '.' ? '' : `${relDir}/`;
                    this.addGitignorePatterns(ig, text, prefix);
                } catch {
                    // ignore read errors
                }
            }

            const infoExcludePath = path.join(folder.uri.fsPath, '.git', 'info', 'exclude');
            if (fs.existsSync(infoExcludePath)) {
                try {
                    const text = fs.readFileSync(infoExcludePath, 'utf8');
                    this.addGitignorePatterns(ig, text, '');
                } catch {
                    // ignore read errors
                }
            }
        }

        return ig;
    }

    private async getCachedGitignoreFiles(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
        const folderPath = folder.uri.fsPath;
        const cached = this.gitignoreCache.get(folderPath);
        if (!cached) {
            return this.refreshGitignoreCache(folder);
        }

        const mtimeMap = cached.mtimeMap;
        for (const filePath of cached.files) {
            try {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                const mtime = stat.mtime;
                if (mtimeMap.get(filePath) !== mtime) {
                    return this.refreshGitignoreCache(folder);
                }
            } catch {
                return this.refreshGitignoreCache(folder);
            }
        }

        return cached.files.map(filePath => vscode.Uri.file(filePath));
    }

    private async refreshGitignoreCache(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
        const gitignoreFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, '**/.gitignore'),
            new vscode.RelativePattern(folder, '**/.git/**')
        );

        const mtimeMap = new Map<string, number>();
        const files: string[] = [];
        for (const uri of gitignoreFiles) {
            files.push(uri.fsPath);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                mtimeMap.set(uri.fsPath, stat.mtime);
            } catch {
                // ignore stat errors
            }
        }

        this.gitignoreCache.set(folder.uri.fsPath, { files, mtimeMap });
        return gitignoreFiles;
    }

    private addGitignorePatterns(ig: Ignore, content: string, prefix: string) {
        const lines = content.split(/\r?\n/);
        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                return;
            }
            if (trimmed.startsWith('!')) {
                ig.add(`!${prefix}${trimmed.slice(1)}`);
            } else {
                ig.add(`${prefix}${trimmed}`);
            }
        });
    }

    private toPosixPath(value: string): string {
        return value.split(path.sep).join(path.posix.sep);
    }

    public testIgnorePath(inputPath?: string): { ignored: boolean; reason: string } {
        if (!inputPath || inputPath.trim().length === 0) {
            return { ignored: false, reason: 'No path provided' };
        }

        const normalizedInput = inputPath.trim();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return { ignored: false, reason: 'No workspace folders' };
        }

        let targetFolder: vscode.WorkspaceFolder | undefined;
        let relPath = normalizedInput;

        if (path.isAbsolute(normalizedInput)) {
            const uri = vscode.Uri.file(normalizedInput);
            targetFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!targetFolder) {
                return { ignored: false, reason: 'Path is outside workspace' };
            }
            relPath = this.toPosixPath(path.relative(targetFolder.uri.fsPath, normalizedInput));
        } else {
            targetFolder = folders[0];
            relPath = this.toPosixPath(relPath);
        }

        let matcher = this.ignoreMatchers.get(targetFolder.uri.fsPath);
        if (!matcher) {
            return { ignored: false, reason: 'Ignore rules not initialized yet' };
        }

        const ignored = matcher.ignores(relPath);
        const result = { ignored, reason: ignored ? 'Matched ignore rules' : 'Not ignored' };
        return result;
    }

    private isPathIgnored(uri: vscode.Uri): boolean {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return true;
        }

        const matcher = this.ignoreMatchers.get(folder.uri.fsPath);
        if (!matcher) {
            return false;
        }

        const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
        const cacheKey = `${folder.uri.fsPath}::${relPath}`;
        const cached = this.ignoreResultCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const ignored = matcher.ignores(relPath);
        this.setIgnoreResultCache(cacheKey, ignored);
        return ignored;
    }

    private pruneIgnoredTrackedChanges(): void {
        const removedFiles: string[] = [];

        for (const filePath of this.trackedChanges.keys()) {
            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) {
                this.deleteTrackedChange(filePath);
                this.lineChanges.delete(filePath);
                this.markLineChangesUpdated(filePath);
                this.inlineViews.delete(filePath);
                removedFiles.push(filePath);
            }
        }

        if (removedFiles.length > 0) {
            this.emitTrackChangesEvent({ removedFiles });
        }
    }

    private async initializeWorkspaceSnapshots(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.snapshotInitialized = true;
            this.baselineBuilding = false;
            this._onDidChangeBaselineState.fire('ready');
            this.schedulePersistState();
            return;
        }

        await this.refreshIgnoreMatchers();

        for (const folder of folders) {
            if (!this.isRecording) {
                return;
            }

            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*'),
                this.shouldUseBuiltInExcludes() ? this.getDefaultExcludeFindFilesPattern(folder) : undefined
            );

            const candidates = files.filter(uri => {
                if (this.isPathIgnored(uri)) {
                    return false;
                }
                return !this.fileSnapshots.has(uri.fsPath);
            });

            const batchSize = 50;
            const readConcurrency = 8;

            for (let i = 0; i < candidates.length; i += batchSize) {
                if (!this.isRecording) {
                    return;
                }

                const batch = candidates.slice(i, i + batchSize);
                await this.runWithConcurrency(batch, readConcurrency, async (uri) => {
                    if (!this.isRecording) {
                        return;
                    }
                    if (this.fileSnapshots.has(uri.fsPath)) {
                        return;
                    }
                    const text = await this.readFileSnapshot(uri);
                    if (text === null) {
                        return;
                    }
                    this.fileSnapshots.set(uri.fsPath, text);
                    this.baselineExistingFiles.add(uri.fsPath);
                });

                if (!this.isRecording) {
                    return;
                }

                await this.yieldToEventLoop();
            }
        }

        this.snapshotInitialized = true;
        if (this.isRecording && this.baselineBuilding) {
            this.baselineBuilding = false;
            this._onDidChangeBaselineState.fire('ready');
        }
        this.processPendingExternalChanges();
        this.schedulePersistState();
    }

    private async readFileSnapshot(uri: vscode.Uri): Promise<string | null> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const maxSizeBytes = 5 * 1024 * 1024;
            if (stat.size > maxSizeBytes) {
                return null;
            }
            const content = await vscode.workspace.fs.readFile(uri);
            if (this.isLikelyBinaryContent(content)) {
                return null;
            }
            return new TextDecoder('utf-8').decode(content);
        } catch {
            return null;
        }
    }

    private async readCurrentFileState(filePath: string): Promise<CurrentFileState> {
        const openDocument = vscode.workspace.textDocuments.find(doc =>
            doc.uri.scheme === 'file' && doc.uri.fsPath === filePath
        );
        if (openDocument) {
            return {
                kind: 'text',
                content: openDocument.getText()
            };
        }

        const uri = vscode.Uri.file(filePath);

        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const maxSizeBytes = 5 * 1024 * 1024;
            if (stat.size > maxSizeBytes) {
                return { kind: 'unavailable' };
            }

            const content = await vscode.workspace.fs.readFile(uri);
            if (this.isLikelyBinaryContent(content)) {
                return { kind: 'unavailable' };
            }

            return {
                kind: 'text',
                content: new TextDecoder('utf-8').decode(content)
            };
        } catch {
            return { kind: 'missing' };
        }
    }

    private async rebuildTrackedChangesFromSnapshots(): Promise<void> {
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();

        const snapshotPaths = Array.from(this.fileSnapshots.keys());
        if (snapshotPaths.length === 0) {
            return;
        }

        await this.runWithConcurrency(snapshotPaths, 8, async (filePath) => {
            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) {
                return;
            }

            const currentState = await this.readCurrentFileState(filePath);
            if (currentState.kind === 'text') {
                this.updateTrackedDiff(filePath, currentState.content);
                return;
            }

            if (currentState.kind === 'missing' && this.baselineExistingFiles.has(filePath)) {
                this.updateTrackedDiff(filePath, '');
            }
        });
    }

    private isLikelyBinaryContent(content: Uint8Array): boolean {
        if (content.length === 0) {
            return false;
        }

        const sampleSize = Math.min(content.length, 8192);
        let nonPrintableCount = 0;

        for (let i = 0; i < sampleSize; i++) {
            const byte = content[i];

            if (byte === 0x00) {
                return true;
            }

            const isAsciiControl = byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;
            const isDel = byte === 0x7f;
            if (isAsciiControl || isDel) {
                nonPrintableCount++;
            }
        }

        return nonPrintableCount / sampleSize > 0.3;
    }

    private async runWithConcurrency<T>(
        items: T[],
        limit: number,
        worker: (item: T) => Promise<void>
    ): Promise<void> {
        let index = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (index < items.length) {
                const current = items[index++];
                await worker(current);
            }
        });
        await Promise.all(workers);
    }

    private async yieldToEventLoop(): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    private async processPendingExternalChanges(): Promise<void> {
        if (this.pendingExternalChanges.size === 0) {
            return;
        }

        const pending = Array.from(this.pendingExternalChanges);
        this.pendingExternalChanges.clear();

        for (const filePath of pending) {
            if (!this.isRecording) {
                return;
            }

            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) {
                continue;
            }

            await this.readFileAndUpdate(filePath, uri);
        }
    }

    private async onExternalFileChanged(uri: vscode.Uri): Promise<void> {
        if (!this.isRecording || !this.externalWatcherEnabled) {
            return;
        }

        if (uri.scheme !== 'file') {
            return;
        }

        if (this.isPathIgnored(uri)) {
            return;
        }

        const filePath = uri.fsPath;
        if (this.shouldTrackOnlyAutomatedChanges() && this.shouldSuppressWatcherEvent(filePath)) {
            return;
        }

        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (doc && doc.isDirty) {
            return;
        }

        if (!this.fileSnapshots.has(filePath) && !this.snapshotInitialized) {
            this.pendingExternalChanges.add(filePath);
            return;
        }

        const existingTimer = this.externalChangeTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.externalChangeTimers.delete(filePath);
            if (!this.isRecording || !this.externalWatcherEnabled) {
                return;
            }
            if (this.isPathIgnored(uri)) {
                return;
            }
            this.readFileAndUpdate(filePath, uri).catch(() => undefined);
        }, 120);

        this.externalChangeTimers.set(filePath, timer);
    }

    private onDocumentOpened(doc: vscode.TextDocument): void {
        this.ensureSnapshotForDocument(doc);
    }

    private async onExternalFileCreated(uri: vscode.Uri): Promise<void> {
        if (!this.isRecording || !this.externalWatcherEnabled) {
            return;
        }

        if (uri.scheme !== 'file') {
            return;
        }

        if (this.isPathIgnored(uri)) {
            return;
        }

        const filePath = uri.fsPath;
        const text = await this.readFileSnapshot(uri);
        if (text === null) {
            this.fileSnapshots.delete(filePath);
            this.baselineExistingFiles.delete(filePath);
            this.schedulePersistState();
            return;
        }
        if (!this.fileSnapshots.has(filePath)) {
            this.fileSnapshots.set(filePath, '');
            this.schedulePersistState();
        }
        this.updateTrackedDiff(filePath, text);
    }

    private async onExternalFileDeleted(uri: vscode.Uri): Promise<void> {
        if (!this.isRecording || !this.externalWatcherEnabled) {
            return;
        }

        if (uri.scheme !== 'file') {
            return;
        }

        if (this.isPathIgnored(uri)) {
            return;
        }

        const filePath = uri.fsPath;
        const originalContent = this.fileSnapshots.get(filePath);
        if (originalContent === undefined) {
            return;
        }

        this.updateTrackedDiff(filePath, '');
    }

    private async readFileAndUpdate(filePath: string, uri: vscode.Uri): Promise<void> {
        const text = await this.readFileSnapshot(uri);
        if (text !== null) {
            this.updateTrackedDiff(filePath, text);
        } else {
            const hadTracked = this.trackedChanges.has(filePath);
            this.deleteTrackedChange(filePath);
            this.lineChanges.delete(filePath);
            this.markLineChangesUpdated(filePath);
            this.inlineViews.delete(filePath);
            if (hadTracked) {
                this.emitTrackChangesEvent({ removedFiles: [filePath] });
            }
        }
    }

    private updateTrackedDiff(
        filePath: string,
        currentContent: string,
        options?: { baselineChanged?: boolean }
    ): void {
        const hadTrackedChange = this.trackedChanges.has(filePath);
        const hadLineChanges = this.lineChanges.has(filePath);
        const hadInlineView = this.inlineViews.has(filePath);
        let originalContent = this.fileSnapshots.get(filePath);
        if (originalContent === undefined) {
            // Fallback baseline for unknown files
            this.fileSnapshots.set(filePath, currentContent);
            this.schedulePersistState();
            return;
        }

        const originalModel = this.toTextLineModel(originalContent);
        const currentModel = this.toTextLineModel(currentContent);
        const sameLogicalLines =
            originalModel.lines.length === currentModel.lines.length &&
            originalModel.lines.every((line, index) => line === currentModel.lines[index]);

        // Ignore pure EOL-style / final-EOL toggles and track only logical line changes.
        if (sameLogicalLines) {
            this.deleteTrackedChange(filePath);
            this.lineChanges.delete(filePath);
            this.markLineChangesUpdated(filePath);
            this.inlineViews.delete(filePath);
            const shouldNotify = hadTrackedChange || hadLineChanges || hadInlineView;
            if (shouldNotify) {
                this.emitTrackChangesEvent({
                    removedFiles: [filePath],
                    baselineChanged: options?.baselineChanged ?? false
                });
            }
            return;
        }

        const normalizedOriginal = this.serializeTextModel(
            { ...originalModel, dominantEol: '\n' },
            '\n'
        );
        const normalizedCurrent = this.serializeTextModel(
            { ...currentModel, dominantEol: '\n' },
            '\n'
        );
        const changes = Diff.diffLines(normalizedOriginal, normalizedCurrent);
        const fileName = filePath.split('/').pop() || filePath;
        const isDeleted = originalContent.length > 0 && currentContent.length === 0;

        this.setTrackedChange(filePath, {
            filePath,
            fileName,
            originalContent,
            currentContent,
            isDeleted,
            changes,
            timestamp: new Date()
        });

        this.calculateLineChanges(filePath);
        this.emitTrackChangesEvent({
            changedFiles: [filePath],
            baselineChanged: options?.baselineChanged ?? false
        });
    }

    public async revertAllChanges(): Promise<number> {
        const changes = Array.from(this.trackedChanges.values());
        let revertedCount = 0;

        for (const change of changes) {
            const restored = await this.restoreFileToContent(
                change.filePath,
                change.originalContent,
                { deleteIfMissingInBaseline: !this.baselineExistingFiles.has(change.filePath) }
            );
            if (restored) {
                revertedCount++;
            }
        }

        // Clear all tracked changes after reverting
        this.clearDiffs();

        return revertedCount;
    }

    public async keepAllChanges(): Promise<number> {
        const changes = Array.from(this.trackedChanges.values());
        if (changes.length === 0) {
            return 0;
        }

        let acceptedCount = 0;
        for (const change of changes) {
            const doc = vscode.workspace.textDocuments.find(textDoc => textDoc.uri.fsPath === change.filePath);
            const currentContent = doc?.getText() ?? change.currentContent;
            this.fileSnapshots.set(change.filePath, currentContent);
            if (change.isDeleted) {
                this.baselineExistingFiles.delete(change.filePath);
            } else {
                this.baselineExistingFiles.add(change.filePath);
            }
            acceptedCount++;
        }

        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.emitTrackChangesEvent({
            removedFiles: changes.map(change => change.filePath),
            baselineChanged: true
        });
        this.schedulePersistState();
        return acceptedCount;
    }

    public async revertFile(filePath: string): Promise<boolean> {
        const change = this.trackedChanges.get(filePath);
        if (!change) {
            return false;
        }

        const restored = await this.restoreFileToContent(
            change.filePath,
            change.originalContent,
            { deleteIfMissingInBaseline: !this.baselineExistingFiles.has(change.filePath) }
        );
        if (!restored) {
            return false;
        }

        this.deleteTrackedChange(filePath);
        this.lineChanges.delete(filePath);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.delete(filePath);
        this.emitTrackChangesEvent({ removedFiles: [filePath] });

        return true;
    }

    private async restoreFileToContent(
        filePath: string,
        content: string,
        options?: { deleteIfMissingInBaseline?: boolean }
    ): Promise<boolean> {
        const uri = vscode.Uri.file(filePath);
        if (options?.deleteIfMissingInBaseline) {
            return this.deleteFileForMissingBaseline(uri, filePath);
        }

        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            const fullRange = this.getFullDocumentRange(doc);

            edit.replace(uri, fullRange, content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                return false;
            }

            await doc.save();
            this.fileSnapshots.set(filePath, doc.getText());
            return true;
        } catch {
            // File may have been deleted. Recreate it from the snapshot content.
            try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
                await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
                this.fileSnapshots.set(filePath, content);
                return true;
            } catch (error) {
                console.error(`Failed to restore ${filePath}:`, error);
                return false;
            }
        }
    }

    private async deleteFileForMissingBaseline(uri: vscode.Uri, filePath: string): Promise<boolean> {
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(uri, { ignoreIfNotExists: true, recursive: false });
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                return false;
            }

            this.fileSnapshots.set(filePath, '');
            this.baselineExistingFiles.delete(filePath);
            return true;
        } catch (error) {
            console.error(`Failed to delete new file ${filePath}:`, error);
            return false;
        }
    }

    public getIsRecording(): boolean {
        return this.isRecording;
    }

    public getBaselineState(): 'idle' | 'building' | 'ready' {
        if (!this.isRecording) {
            return 'idle';
        }
        return this.baselineBuilding ? 'building' : 'ready';
    }

    public getTrackedChanges(): FileDiff[] {
        if (this.trackedChangesCacheVersion !== this.trackedChangesVersion) {
            this.trackedChangesCache = Array.from(this.trackedChanges.values())
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
            this.trackedChangesCacheVersion = this.trackedChangesVersion;
        }

        return this.trackedChangesCache.slice();
    }

    public getLineChanges(filePath: string): LineChange[] | undefined {
        return this.lineChanges.get(filePath);
    }

    public getOriginalContent(filePath: string): string | undefined {
        return this.fileSnapshots.get(filePath);
    }

    public getInlineContent(filePath: string): string | undefined {
        const view = this.ensureInlineView(filePath);
        if (!view) {
            return undefined;
        }

        return view.content;
    }

    public getInlineView(filePath: string): InlineDiffView | undefined {
        return this.ensureInlineView(filePath);
    }

    public buildInlineViewFromContents(originalContent: string, currentContent: string): InlineDiffView {
        return this.buildDiffViewFromContents(
            originalContent,
            currentContent
        ).inlineView;
    }

    /**
     * Revert a specific change block to its original content
     */
    public async revertBlock(filePath: string, blockRef: string | number): Promise<boolean> {
        const originalContent = this.fileSnapshots.get(filePath);

        if (originalContent === undefined) {
            return false;
        }

        const block = this.resolveBlock(filePath, blockRef);
        if (!block) {
            return false;
        }

        try {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const currentModel = this.toTextLineModel(doc.getText());
            const originalModel = this.toTextLineModel(originalContent);
            const nextLines = [...currentModel.lines];
            const startIdx = Math.max(0, block.startLine - 1);
            const deleteCount = Math.max(0, block.endLine - block.startLine + 1);

            if (block.type === 'added') {
                nextLines.splice(startIdx, deleteCount);
            } else if (block.type === 'modified') {
                const originalBlockLines = this.getOrderedOriginalLines(block);
                nextLines.splice(startIdx, deleteCount, ...originalBlockLines);
            } else if (block.type === 'deleted') {
                const deletedLines = this.getOrderedOriginalLines(block);
                nextLines.splice(startIdx, 0, ...deletedLines);
            }

            const nextHasFinalEol = this.blockTouchesEof(block, currentModel.lines.length, originalModel.lines.length)
                ? originalModel.hasFinalEol
                : currentModel.hasFinalEol;
            const nextText = this.serializeTextModel(
                {
                    lines: nextLines,
                    hasFinalEol: nextHasFinalEol,
                    dominantEol: currentModel.dominantEol
                },
                currentModel.dominantEol
            );

            if (nextText === doc.getText()) {
                return true;
            }

            const edit = new vscode.WorkspaceEdit();
            const fullRange = this.getFullDocumentRange(doc);
            edit.replace(uri, fullRange, nextText);

            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                return false;
            }

            // Refresh immediately so WebView/CodeLens state does not wait for debounced document-change events.
            this.updateTrackedDiff(filePath, nextText);
            return true;
        } catch (error) {
            console.error(`Failed to revert block in ${filePath}:`, error);
            return false;
        }
    }

    /**
     * Keep a specific change block (accept the changes)
     * Updates the snapshot so this block's changes become the new baseline
     */
    public async keepBlock(filePath: string, blockRef: string | number): Promise<boolean> {
        const block = this.resolveBlock(filePath, blockRef);
        if (!block) {
            return false;
        }
        const originalContent = this.fileSnapshots.get(filePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        const currentText = doc?.getText() ?? this.trackedChanges.get(filePath)?.currentContent;

        if (originalContent === undefined || currentText === undefined) {
            return false;
        }

        const originalModel = this.toTextLineModel(originalContent);
        const currentModel = this.toTextLineModel(currentText);
        const originalLines = [...originalModel.lines];
        const currentLines = currentModel.lines;

        // Get current file's lines for this block (what we want to keep)
        const currentBlockLines = currentLines.slice(block.startLine - 1, block.endLine);

        // Find original line numbers affected by this block
        const originalLineNumbers = block.changes
            .map(c => c.originalLineNumber)
            .filter((n): n is number => n !== undefined);

        if (block.type === 'deleted') {
            // Deleted block: remove lines from original (they don't exist in current)
            // Sort descending to avoid index shifting issues
            const sortedDesc = [...new Set(originalLineNumbers)].sort((a, b) => b - a);
            for (const origLineNum of sortedDesc) {
                const idx = origLineNum - 1;
                if (idx >= 0 && idx < originalLines.length) {
                    originalLines.splice(idx, 1);
                }
            }
        } else if (originalLineNumbers.length > 0) {
            // Modified or mixed block: replace original lines with current block lines
            const minOrig = Math.min(...originalLineNumbers);
            const maxOrig = Math.max(...originalLineNumbers);
            const origStartIdx = minOrig - 1;
            const deleteCount = maxOrig - minOrig + 1;
            originalLines.splice(origStartIdx, deleteCount, ...currentBlockLines);
        } else {
            // Pure addition (no original lines): insert at block position
            // Find the closest preceding unchanged line to determine insert position
            const insertIdx = Math.max(0, block.startLine - 1);
            originalLines.splice(insertIdx, 0, ...currentBlockLines);
        }

        // Update snapshot using current editor newline style while keeping logical accepted content.
        const keepHasFinalEol = this.blockTouchesEof(block, currentModel.lines.length, originalModel.lines.length)
            ? currentModel.hasFinalEol
            : originalModel.hasFinalEol;
        const newSnapshot = this.serializeTextModel(
            {
                lines: originalLines,
                hasFinalEol: keepHasFinalEol,
                dominantEol: currentModel.dominantEol
            },
            currentModel.dominantEol
        );
        this.fileSnapshots.set(filePath, newSnapshot);
        this.baselineExistingFiles.add(filePath);
        this.schedulePersistState();

        // Recompute diff against updated snapshot
        this.updateTrackedDiff(filePath, currentText, { baselineChanged: true });
        return true;
    }

    /**
     * Keep all changes in a file (accept all changes)
     * Updates the snapshot to match current document content
     */
    public async keepAllChangesInFile(filePath: string): Promise<boolean> {
        const tracked = this.trackedChanges.get(filePath);
        let currentContent = tracked?.currentContent;

        if (currentContent === undefined) {
            let doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
            if (!doc) {
                try {
                    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                } catch {
                    return false;
                }
            }
            currentContent = doc.getText();
        }

        // Update snapshot to current content
        this.fileSnapshots.set(filePath, currentContent);
        if (tracked?.isDeleted) {
            this.baselineExistingFiles.delete(filePath);
        } else {
            this.baselineExistingFiles.add(filePath);
        }

        // Clear tracked changes for this file
        this.deleteTrackedChange(filePath);
        this.lineChanges.delete(filePath);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.delete(filePath);

        this.emitTrackChangesEvent({
            removedFiles: [filePath],
            baselineChanged: true
        });
        this.schedulePersistState();
        return true;
    }

    /**
     * Get change blocks for a file (used by CodeLens)
     */
    public getChangeBlocks(filePath: string): ChangeBlock[] {
        const currentVersion = this.lineChangesVersionByFile.get(filePath) ?? 0;
        const cached = this.changeBlocksCache.get(filePath);
        if (cached && cached.version === currentVersion) {
            return cached.blocks.slice();
        }

        const lineChanges = this.lineChanges.get(filePath);
        if (!lineChanges || lineChanges.length === 0) {
            const emptyBlocks: ChangeBlock[] = [];
            this.changeBlocksCache.set(filePath, { version: currentVersion, blocks: emptyBlocks });
            return [];
        }

        // Keep original order from diff computation; sorting by line number can break EOF deletions.
        const changes = lineChanges
            .filter(c => c.type !== 'unchanged');

        if (changes.length === 0) {
            const emptyBlocks: ChangeBlock[] = [];
            this.changeBlocksCache.set(filePath, { version: currentVersion, blocks: emptyBlocks });
            return [];
        }

        const shouldMerge = (prev: LineChange, next: LineChange): boolean => {
            const prevSegment = prev.segmentId;
            const nextSegment = next.segmentId;
            if (prevSegment !== undefined && nextSegment !== undefined) {
                return prevSegment === nextSegment;
            }
            if (prevSegment !== undefined || nextSegment !== undefined) {
                return false;
            }
            return next.lineNumber <= prev.lineNumber + 1;
        };

        const groupedChanges: LineChange[][] = [];
        let currentGroup: LineChange[] = [];
        for (const change of changes) {
            if (currentGroup.length === 0) {
                currentGroup = [change];
                continue;
            }

            const prev = currentGroup[currentGroup.length - 1];
            if (shouldMerge(prev, change)) {
                currentGroup.push(change);
            } else {
                groupedChanges.push(currentGroup);
                currentGroup = [change];
            }
        }

        if (currentGroup.length > 0) {
            groupedChanges.push(currentGroup);
        }

        const coalescedGroups = this.coalesceChangeGroups(groupedChanges);
        const idCounter = new Map<string, number>();
        const blocks = coalescedGroups.map((group, index) => {
            const startLine = Math.min(...group.map(change => change.lineNumber));
            const endLine = Math.max(...group.map(change => change.lineNumber));

            const hasAdded = group.some(change => change.type === 'added');
            const hasDeleted = group.some(change => change.type === 'deleted');
            const hasModified = group.some(change => change.type === 'modified');
            const type: 'added' | 'modified' | 'deleted' =
                hasModified || (hasAdded && hasDeleted)
                    ? 'modified'
                    : (hasDeleted ? 'deleted' : 'added');

            const originalLineNumbers = group
                .map(change => change.originalLineNumber)
                .filter((n): n is number => n !== undefined)
                .sort((a, b) => a - b);
            const originalStart = originalLineNumbers.length > 0 ? originalLineNumbers[0] : 0;
            const originalEnd = originalLineNumbers.length > 0 ? originalLineNumbers[originalLineNumbers.length - 1] : 0;
            const segmentIds = [...new Set(
                group
                    .map(change => change.segmentId)
                    .filter((segmentId): segmentId is number => segmentId !== undefined)
            )].sort((a, b) => a - b);
            const segmentKey = segmentIds.length > 0 ? segmentIds.join(',') : '0';
            const key = `${type}:${startLine}:${endLine}:${originalStart}:${originalEnd}:${segmentKey}`;
            const seen = idCounter.get(key) ?? 0;
            idCounter.set(key, seen + 1);

            return {
                startLine,
                endLine,
                type,
                changes: group,
                blockId: `${filePath}::${key}:${seen + 1}`,
                blockIndex: index
            };
        });
        this.changeBlocksCache.set(filePath, { version: currentVersion, blocks });
        return blocks.slice();
    }

    private coalesceChangeGroups(groups: LineChange[][]): LineChange[][] {
        if (groups.length <= 1) {
            return groups;
        }

        const coalesced: LineChange[][] = [];
        for (const group of groups) {
            if (group.length === 0) {
                continue;
            }

            if (coalesced.length === 0) {
                coalesced.push([...group]);
                continue;
            }

            const previous = coalesced[coalesced.length - 1];
            if (this.isSameEditCluster(previous, group)) {
                previous.push(...group);
            } else {
                coalesced.push([...group]);
            }
        }

        return coalesced;
    }

    private isSameEditCluster(prevGroup: LineChange[], nextGroup: LineChange[]): boolean {
        const prevSegments = new Set(
            prevGroup
                .map(change => change.segmentId)
                .filter((segmentId): segmentId is number => segmentId !== undefined)
        );
        const nextSegments = new Set(
            nextGroup
                .map(change => change.segmentId)
                .filter((segmentId): segmentId is number => segmentId !== undefined)
        );

        if (prevSegments.size > 0 && nextSegments.size > 0) {
            for (const segmentId of prevSegments) {
                if (nextSegments.has(segmentId)) {
                    return true;
                }
            }
        }

        const prevCurrentRange = this.getLineRange(prevGroup.map(change => change.lineNumber));
        const nextCurrentRange = this.getLineRange(nextGroup.map(change => change.lineNumber));
        const currentRangesTouch = this.areRangesAdjacentOrOverlapping(prevCurrentRange, nextCurrentRange);

        const combinedTypes = new Set<LineChange['type']>(
            [...prevGroup, ...nextGroup]
                .map(change => change.type)
                .filter(type => type !== 'unchanged')
        );

        if (currentRangesTouch && combinedTypes.size >= 2) {
            return true;
        }

        const oneSidePureBlankAdded = this.isPureBlankAddedGroup(prevGroup) || this.isPureBlankAddedGroup(nextGroup);
        if (!oneSidePureBlankAdded) {
            return false;
        }

        const otherGroup = this.isPureBlankAddedGroup(prevGroup) ? nextGroup : prevGroup;
        const hasModifiedOrDeleted = otherGroup.some(change => change.type === 'modified' || change.type === 'deleted');
        if (!hasModifiedOrDeleted) {
            return false;
        }

        const prevOriginalRange = this.getLineRange(
            prevGroup
                .map(change => change.originalLineNumber)
                .filter((line): line is number => line !== undefined)
        );
        const nextOriginalRange = this.getLineRange(
            nextGroup
                .map(change => change.originalLineNumber)
                .filter((line): line is number => line !== undefined)
        );
        const originalRangesTouch = this.areRangesAdjacentOrOverlapping(prevOriginalRange, nextOriginalRange);

        return currentRangesTouch || originalRangesTouch;
    }

    private isPureBlankAddedGroup(group: LineChange[]): boolean {
        if (group.length === 0) {
            return false;
        }

        return group.every(change => change.type === 'added' && (change.newText ?? '').trim().length === 0);
    }

    private getLineRange(lines: number[]): { start: number; end: number } | undefined {
        if (lines.length === 0) {
            return undefined;
        }

        const positiveLines = lines.filter(line => Number.isFinite(line) && line > 0);
        if (positiveLines.length === 0) {
            return undefined;
        }

        return {
            start: Math.min(...positiveLines),
            end: Math.max(...positiveLines)
        };
    }

    private areRangesAdjacentOrOverlapping(
        first: { start: number; end: number } | undefined,
        second: { start: number; end: number } | undefined
    ): boolean {
        if (!first || !second) {
            return false;
        }

        return second.start <= first.end + 1 && first.start <= second.end + 1;
    }

    private resolveBlock(filePath: string, blockRef: string | number): ChangeBlock | undefined {
        const blocks = this.getChangeBlocks(filePath);
        if (typeof blockRef === 'number') {
            if (blockRef < 0 || blockRef >= blocks.length) {
                return undefined;
            }
            return blocks[blockRef];
        }

        return blocks.find(block => block.blockId === blockRef);
    }

    private onDocumentChanged(event: vscode.TextDocumentChangeEvent) {
        if (!this.isRecording) {
            return;
        }

        const doc = event.document;
        if (doc.uri.scheme !== 'file') {
            return;
        }

        const filePath = doc.uri.fsPath;
        const uri = doc.uri;
        if (this.isPathIgnored(uri)) {
            return;
        }

        if (this.shouldTrackOnlyAutomatedChanges() && !this.isAutomationChangeAllowed(filePath)) {
            return;
        }

        // For files without snapshot (not open when recording started),
        // capture the document's current content BEFORE this change as the baseline.
        // We do this immediately (before debounce) to avoid autosave overwriting
        // the on-disk content and erasing the true baseline.
        if (!this.fileSnapshots.has(filePath)) {
            // Defensive fallback: normal path should be covered by start/open snapshot capture.
            try {
                const originalContent = fs.readFileSync(filePath, 'utf8');
                this.fileSnapshots.set(filePath, originalContent);
                this.baselineExistingFiles.add(filePath);
                this.schedulePersistState();
            } catch (error) {
                // File doesn't exist on disk (truly new file), use empty
                this.fileSnapshots.set(filePath, '');
                this.baselineExistingFiles.delete(filePath);
                this.schedulePersistState();
            }
        }

        const existingTimer = this.documentChangeTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.documentChangeTimers.delete(filePath);
            if (!this.isRecording) {
                return;
            }
            this.processDocumentChange(doc);
        }, 120);

        this.documentChangeTimers.set(filePath, timer);
    }

    private processDocumentChange(doc: vscode.TextDocument): void {
        if (!this.isRecording) {
            return;
        }

        if (doc.uri.scheme !== 'file') {
            return;
        }

        const filePath = doc.uri.fsPath;
        const uri = doc.uri;
        if (this.isPathIgnored(uri)) {
            return;
        }

        const currentContent = doc.getText();
        this.updateTrackedDiff(filePath, currentContent);
    }

    private ensureInlineView(filePath: string): InlineDiffView | undefined {
        const cached = this.inlineViews.get(filePath);
        if (cached) {
            return cached;
        }

        const view = this.buildDiffView(filePath);
        if (!view) {
            return undefined;
        }

        this.lineChanges.set(filePath, view.lineChanges);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.set(filePath, view.inlineView);
        return view.inlineView;
    }

    private getCurrentContent(filePath: string): string | undefined {
        const tracked = this.trackedChanges.get(filePath);
        if (tracked) {
            return tracked.currentContent;
        }

        const doc = vscode.workspace.textDocuments.find(textDoc => textDoc.uri.fsPath === filePath);
        return doc?.getText();
    }

    private ensureSnapshotForDocument(doc: vscode.TextDocument): void {
        if (!this.isRecording) {
            return;
        }

        if (doc.uri.scheme !== 'file') {
            return;
        }

        const filePath = doc.uri.fsPath;
        if (this.fileSnapshots.has(filePath)) {
            return;
        }

        if (this.isPathIgnored(doc.uri)) {
            return;
        }

        this.fileSnapshots.set(filePath, doc.getText());
        this.baselineExistingFiles.add(filePath);
        this.schedulePersistState();
    }

    private calculateLineChanges(filePath: string) {
        const view = this.buildDiffView(filePath);
        if (!view) {
            this.lineChanges.delete(filePath);
            this.markLineChangesUpdated(filePath);
            this.inlineViews.delete(filePath);
            return;
        }

        this.lineChanges.set(filePath, view.lineChanges);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.set(filePath, view.inlineView);
    }

    private buildDiffView(filePath: string): { lineChanges: LineChange[]; inlineView: InlineDiffView } | undefined {
        const originalContent = this.fileSnapshots.get(filePath);
        const currentContent = this.getCurrentContent(filePath);

        if (originalContent === undefined || currentContent === undefined) {
            return undefined;
        }

        return this.buildDiffViewFromContents(originalContent, currentContent);
    }

    private buildDiffViewFromContents(
        originalContent: string,
        currentContent: string
    ): { lineChanges: LineChange[]; inlineView: InlineDiffView } {
        const originalModel = this.toTextLineModel(originalContent);
        const currentModel = this.toTextLineModel(currentContent);

        return this.buildDiffViewFromLines(
            originalModel.lines,
            currentModel.lines,
            originalModel.hasFinalEol,
            currentModel.hasFinalEol
        );
    }

    private buildDiffViewFromLines(
        originalLines: string[],
        currentLines: string[],
        originalHasFinalEol: boolean,
        currentHasFinalEol: boolean
    ): { lineChanges: LineChange[]; inlineView: InlineDiffView } {
        const originalNormalized = originalLines.map(line => this.normalizeLineForMatch(line));
        const currentNormalized = currentLines.map(line => this.normalizeLineForMatch(line));

        const diffResult = Diff.diffArrays(originalLines, currentLines);
        const lineChanges: LineChange[] = [];
        const inlineLines: string[] = [];
        const inlineTypes: InlineLineType[] = [];

        let originalIndex = 0;
        let currentIndex = 0;
        let originalLineNumber = 1;
        let currentLineNumber = 1;
        let lastMatchedCurrentLine = 0;
        let nextSegmentId = 1;
        let activeSegmentId: number | undefined;

        const pendingRemoved: PendingRemovedLine[] = [];
        const beginSegment = (): number => {
            if (activeSegmentId === undefined) {
                activeSegmentId = nextSegmentId++;
            }
            return activeSegmentId;
        };
        const closeSegment = (): void => {
            activeSegmentId = undefined;
        };

        const flushPendingRemoved = () => {
            if (pendingRemoved.length === 0) {
                return;
            }

            const segmentId = beginSegment();
            const anchorLine = lastMatchedCurrentLine;
            pendingRemoved.forEach(removed => {
                lineChanges.push({
                    lineNumber: currentLineNumber,
                    type: 'deleted',
                    originalLineNumber: removed.originalLineNumber,
                    oldText: removed.text,
                    anchorLineNumber: anchorLine,
                    segmentId
                });
                inlineLines.push(removed.text);
                inlineTypes.push('deleted');
            });

            pendingRemoved.length = 0;
        };

        for (const change of diffResult) {
            const length = change.value.length;
            if (length === 0) {
                continue;
            }

            if (change.removed) {
                for (let i = 0; i < length; i++) {
                    const oldLine = originalLines[originalIndex] ?? '';
                    pendingRemoved.push({
                        text: oldLine,
                        normalized: originalNormalized[originalIndex] ?? this.normalizeLineForMatch(oldLine),
                        originalLineNumber
                    });
                    originalIndex++;
                    originalLineNumber++;
                }
                continue;
            }

            if (change.added) {
                const segmentId = beginSegment();
                const addedLines = currentLines.slice(currentIndex, currentIndex + length);
                const addedNormalized = currentNormalized.slice(currentIndex, currentIndex + length);
                const pairing = this.pairLinesBySimilarity(pendingRemoved, addedLines, addedNormalized);

                pairing.pairedByAdded.forEach((deletedIndex, addedIndex) => {
                    const deleted = pendingRemoved[deletedIndex];
                    const nextLine = addedLines[addedIndex] ?? '';
                    lineChanges.push({
                        lineNumber: currentLineNumber + addedIndex,
                        type: 'modified',
                        originalLineNumber: deleted.originalLineNumber,
                        oldText: deleted.text,
                        newText: nextLine,
                        segmentId
                    });
                });

                const canSuppressBlankDeletes =
                    pendingRemoved.length > 0 &&
                    pendingRemoved.every(removed => (removed.text ?? '').trim().length === 0) &&
                    pendingRemoved.length === addedLines.length;

                pairing.unpairedDeleted.forEach(index => {
                    const deleted = pendingRemoved[index];
                    const isBlankDeleted = (deleted?.text ?? '').trim().length === 0;
                    if (canSuppressBlankDeletes && isBlankDeleted) {
                        return;
                    }

                    lineChanges.push({
                        lineNumber: currentLineNumber,
                        type: 'deleted',
                        originalLineNumber: deleted.originalLineNumber,
                        oldText: deleted.text,
                        anchorLineNumber: lastMatchedCurrentLine,
                        segmentId
                    });
                });

                pairing.unpairedAdded.forEach(index => {
                    const addedLine = addedLines[index] ?? '';
                    lineChanges.push({
                        lineNumber: currentLineNumber + index,
                        type: 'added',
                        newText: addedLine,
                        segmentId
                    });
                });

                const inlineDeleted = canSuppressBlankDeletes
                    ? pendingRemoved.filter(removed => (removed.text ?? '').trim().length !== 0)
                    : pendingRemoved;

                inlineDeleted.forEach(removed => {
                    inlineLines.push(removed.text);
                    inlineTypes.push('deleted');
                });

                addedLines.forEach(line => {
                    inlineLines.push(line ?? '');
                    inlineTypes.push('added');
                });

                pendingRemoved.length = 0;
                currentIndex += length;
                currentLineNumber += length;
                continue;
            }

            flushPendingRemoved();
            closeSegment();

            for (let i = 0; i < length; i++) {
                const newLine = currentLines[currentIndex] ?? '';
                inlineLines.push(newLine);
                inlineTypes.push('unchanged');
                lineChanges.push({
                    lineNumber: currentLineNumber,
                    type: 'unchanged',
                    originalLineNumber
                });
                originalIndex++;
                currentIndex++;
                originalLineNumber++;
                lastMatchedCurrentLine = currentLineNumber;
                currentLineNumber++;
            }
        }

        flushPendingRemoved();
        closeSegment();

        // Track metadata so final-EOL-only edits do not create phantom blocks.
        if (originalHasFinalEol !== currentHasFinalEol && lineChanges.every(change => change.type === 'unchanged')) {
            lineChanges.length = 0;
            inlineLines.length = 0;
            inlineTypes.length = 0;
            for (let i = 0; i < currentLines.length; i++) {
                inlineLines.push(currentLines[i] ?? '');
                inlineTypes.push('unchanged');
                lineChanges.push({
                    lineNumber: i + 1,
                    type: 'unchanged',
                    originalLineNumber: i + 1
                });
            }
        }

        return {
            lineChanges,
            inlineView: {
                content: inlineLines.join('\n'),
                lineTypes: inlineTypes
            }
        };
    }

    private pairLinesBySimilarity(
        deletedLines: PendingRemovedLine[],
        addedLines: string[],
        addedNormalized: string[]
    ): {
        pairedByAdded: Map<number, number>,
        unpairedDeleted: number[],
        unpairedAdded: number[]
    } {
        const pairedByAdded = new Map<number, number>();
        const usedDeleted = new Set<number>();
        const usedAdded = new Set<number>();

        // Always pair by position first (up to the minimum count).
        // This treats adjacent deleted+added as "modified" rather than separate operations,
        // which matches user expectations for edits like "# TBD" -> "# TBD123".
        const minLen = Math.min(deletedLines.length, addedLines.length);
        for (let i = 0; i < minLen; i++) {
            pairedByAdded.set(i, i);
            usedDeleted.add(i);
            usedAdded.add(i);
        }

        // If counts differ, try to pair remaining lines by similarity to keep modified hunks compact.
        const similarityThreshold = 0.3;
        const maxOffset = 5;
        for (let i = 0; i < addedLines.length; i++) {
            if (usedAdded.has(i)) {
                continue;
            }

            let bestDeleted = -1;
            let bestSimilarity = 0;

            for (let j = 0; j < deletedLines.length; j++) {
                if (usedDeleted.has(j)) {
                    continue;
                }

                if (Math.abs(j - i) > maxOffset) {
                    continue;
                }

                const similarity = this.calculatePairSimilarity(
                    deletedLines[j],
                    addedLines[i],
                    addedNormalized[i]
                );

                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestDeleted = j;
                }
            }

            if (bestDeleted >= 0 && bestSimilarity >= similarityThreshold) {
                pairedByAdded.set(i, bestDeleted);
                usedDeleted.add(bestDeleted);
                usedAdded.add(i);
            }
        }

        // Remaining unpaired lines stay as pure deleted or pure added

        const unpairedDeleted = deletedLines
            .map((_, index) => index)
            .filter(index => !usedDeleted.has(index));

        const unpairedAdded = addedLines
            .map((_, index) => index)
            .filter(index => !usedAdded.has(index));

        return { pairedByAdded, unpairedDeleted, unpairedAdded };
    }

    private calculatePairSimilarity(
        deleted: PendingRemovedLine,
        addedLine: string,
        addedNormalized: string
    ): number {
        if (deleted.normalized.length > 0 && deleted.normalized === addedNormalized) {
            return 1;
        }

        const rawSimilarity = this.calculateSetSimilarity(deleted.text, addedLine);
        const normalizedSimilarity = this.calculateSetSimilarity(deleted.normalized, addedNormalized);

        return Math.max(rawSimilarity, normalizedSimilarity);
    }

    private calculateSetSimilarity(str1: string | undefined, str2: string | undefined): number {
        const tokens1 = this.tokenizeForSimilarity(str1);
        const tokens2 = this.tokenizeForSimilarity(str2);

        if (tokens1.length === 0 && tokens2.length === 0) {
            return 1;
        }

        const counts1 = new Map<string, number>();
        const counts2 = new Map<string, number>();
        for (const token of tokens1) {
            counts1.set(token, (counts1.get(token) ?? 0) + 1);
        }
        for (const token of tokens2) {
            counts2.set(token, (counts2.get(token) ?? 0) + 1);
        }

        let overlapCount = 0;
        for (const [token, count1] of counts1.entries()) {
            const count2 = counts2.get(token) ?? 0;
            overlapCount += Math.min(count1, count2);
        }

        const totalCount = tokens1.length + tokens2.length;
        return totalCount > 0 ? (2 * overlapCount) / totalCount : 0;
    }

    private tokenizeForSimilarity(input: string | undefined): string[] {
        const normalized = (input ?? '').trim().replace(/\s+/g, ' ');
        if (!normalized) {
            return [];
        }

        const tokens = normalized.match(/[A-Za-z0-9_]+/g);
        if (tokens && tokens.length > 0) {
            return tokens;
        }

        const compact = normalized.replace(/\s+/g, '');
        return [...compact];
    }

    private detectDominantEol(content: string): '\n' | '\r\n' | '\r' {
        const matches = content.match(/\r\n|\r|\n/g);
        if (!matches || matches.length === 0) {
            return '\n';
        }

        let lf = 0;
        let crlf = 0;
        let cr = 0;
        for (const token of matches) {
            if (token === '\r\n') {
                crlf++;
            } else if (token === '\r') {
                cr++;
            } else {
                lf++;
            }
        }

        if (crlf >= lf && crlf >= cr) {
            return '\r\n';
        }
        if (lf >= cr) {
            return '\n';
        }
        return '\r';
    }

    private normalizeEol(content: string): string {
        return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    private toTextLineModel(content: string): TextLineModel {
        const dominantEol = this.detectDominantEol(content);
        const normalized = this.normalizeEol(content);
        if (normalized.length === 0) {
            return { lines: [], hasFinalEol: false, dominantEol };
        }

        const hasFinalEol = normalized.endsWith('\n');
        const split = normalized.split('\n');
        const lines = hasFinalEol ? split.slice(0, -1) : split;
        return { lines, hasFinalEol, dominantEol };
    }

    private serializeTextModel(model: TextLineModel, preferredEol?: '\n' | '\r\n' | '\r'): string {
        const eol = preferredEol ?? model.dominantEol;
        let value = model.lines.join(eol);
        if (model.hasFinalEol) {
            value += eol;
        }
        return value;
    }

    private getOrderedOriginalLines(block: ChangeBlock): string[] {
        const byOriginalLine = new Map<number, string>();
        for (const change of block.changes) {
            if (change.originalLineNumber === undefined || change.oldText === undefined) {
                continue;
            }
            if (!byOriginalLine.has(change.originalLineNumber)) {
                byOriginalLine.set(change.originalLineNumber, change.oldText);
            }
        }

        if (byOriginalLine.size > 0) {
            return [...byOriginalLine.entries()]
                .sort((a, b) => a[0] - b[0])
                .map((entry) => entry[1]);
        }

        const fallback: string[] = [];
        for (const change of block.changes) {
            if (change.oldText !== undefined) {
                fallback.push(change.oldText);
            }
        }
        return fallback;
    }

    private blockTouchesEof(
        block: ChangeBlock,
        currentLineCount: number,
        originalLineCount: number
    ): boolean {
        const touchesCurrent = currentLineCount === 0 || block.endLine >= currentLineCount;
        const maxOriginal = block.changes
            .map(change => change.originalLineNumber ?? 0)
            .reduce((max, value) => Math.max(max, value), 0);
        const touchesOriginal = maxOriginal > 0 && maxOriginal >= originalLineCount;
        return touchesCurrent || touchesOriginal;
    }

    private getFullDocumentRange(doc: vscode.TextDocument): vscode.Range {
        if (doc.lineCount === 0) {
            return new vscode.Range(0, 0, 0, 0);
        }

        const firstLine = doc.lineAt(0);
        const lastLine = doc.lineAt(doc.lineCount - 1);
        const end = lastLine.rangeIncludingLineBreak.end;
        return new vscode.Range(firstLine.range.start, end);
    }

    /**
     * Patience Diff algorithm implementation.
     * 
     * Unlike LCS-based diff, this algorithm:
     * 1. Finds unique lines (appearing exactly once in both old and new)
     * 2. Uses unique lines as anchors
     * 3. Falls back to positional diff (not LCS) when no unique lines exist
     * 
     * This produces more intuitive diffs when similar code blocks exist nearby.
     */
    private patienceDiff(
        oldLines: string[],
        newLines: string[]
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        return this.patienceDiffRecursive(oldLines, 0, oldLines.length, newLines, 0, newLines.length);
    }

    private patienceDiffRecursive(
        oldLines: string[],
        oldStart: number,
        oldEnd: number,
        newLines: string[],
        newStart: number,
        newEnd: number
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        // Base cases
        if (oldStart >= oldEnd && newStart >= newEnd) {
            return [];
        }
        if (oldStart >= oldEnd) {
            // All remaining new lines are additions
            return [{ value: newLines.slice(newStart, newEnd), added: true }];
        }
        if (newStart >= newEnd) {
            // All remaining old lines are deletions
            return [{ value: oldLines.slice(oldStart, oldEnd), removed: true }];
        }

        // Find unique lines and their positions
        const oldUniques = this.findUniqueLineIndices(oldLines, oldStart, oldEnd);
        const newUniques = this.findUniqueLineIndices(newLines, newStart, newEnd);

        // Find matching unique lines (anchors)
        const anchors = this.findAnchors(oldLines, oldUniques, newLines, newUniques);

        if (anchors.length === 0) {
            // No anchors: fall back to positional diff
            return this.positionalDiff(oldLines, oldStart, oldEnd, newLines, newStart, newEnd);
        }

        // Process blocks between anchors
        const result: Array<{ value: string[]; added?: boolean; removed?: boolean }> = [];
        let prevOldIdx = oldStart;
        let prevNewIdx = newStart;

        for (const [oldIdx, newIdx] of anchors) {
            // Recursively process content before this anchor
            const beforeDiff = this.patienceDiffRecursive(
                oldLines, prevOldIdx, oldIdx,
                newLines, prevNewIdx, newIdx
            );
            result.push(...beforeDiff);

            // Add the anchor line itself (unchanged)
            result.push({ value: [oldLines[oldIdx]] });

            prevOldIdx = oldIdx + 1;
            prevNewIdx = newIdx + 1;
        }

        // Process content after the last anchor
        const afterDiff = this.patienceDiffRecursive(
            oldLines, prevOldIdx, oldEnd,
            newLines, prevNewIdx, newEnd
        );
        result.push(...afterDiff);

        return this.mergeConsecutiveChanges(result);
    }

    /**
     * Find indices of lines that appear exactly once in the given range.
     */
    private findUniqueLineIndices(
        lines: string[],
        start: number,
        end: number
    ): Map<string, number> {
        const counts = new Map<string, { count: number; index: number }>();

        for (let i = start; i < end; i++) {
            const line = lines[i];
            const existing = counts.get(line);
            if (existing) {
                existing.count++;
            } else {
                counts.set(line, { count: 1, index: i });
            }
        }

        const uniques = new Map<string, number>();
        for (const [line, { count, index }] of counts) {
            if (count === 1) {
                uniques.set(line, index);
            }
        }
        return uniques;
    }

    /**
     * Find matching unique lines between old and new, maintaining order.
     * Uses LCS on the unique lines only to find the longest matching sequence.
     */
    private findAnchors(
        oldLines: string[],
        oldUniques: Map<string, number>,
        newLines: string[],
        newUniques: Map<string, number>
    ): Array<[number, number]> {
        // Find common unique lines
        const commonUniques: Array<{ line: string; oldIdx: number; newIdx: number }> = [];

        for (const [line, oldIdx] of oldUniques) {
            const newIdx = newUniques.get(line);
            if (newIdx !== undefined) {
                commonUniques.push({ line, oldIdx, newIdx });
            }
        }

        if (commonUniques.length === 0) {
            return [];
        }

        // Sort by position in old file
        commonUniques.sort((a, b) => a.oldIdx - b.oldIdx);

        // Find LCS by new index (patience sorting)
        // This ensures we get the longest sequence of anchors that maintains order in both files
        const lcs = this.longestIncreasingSubsequence(
            commonUniques.map(u => u.newIdx)
        );

        return lcs.map(i => [commonUniques[i].oldIdx, commonUniques[i].newIdx] as [number, number]);
    }

    /**
     * Find the longest increasing subsequence indices.
     * Used to find the best anchor chain that maintains order.
     */
    private longestIncreasingSubsequence(nums: number[]): number[] {
        if (nums.length === 0) {
            return [];
        }

        const n = nums.length;
        const dp: number[] = new Array(n).fill(1);
        const parent: number[] = new Array(n).fill(-1);

        for (let i = 1; i < n; i++) {
            for (let j = 0; j < i; j++) {
                if (nums[j] < nums[i] && dp[j] + 1 > dp[i]) {
                    dp[i] = dp[j] + 1;
                    parent[i] = j;
                }
            }
        }

        // Find the index with maximum length
        let maxLen = 0;
        let maxIdx = 0;
        for (let i = 0; i < n; i++) {
            if (dp[i] > maxLen) {
                maxLen = dp[i];
                maxIdx = i;
            }
        }

        // Reconstruct the sequence
        const result: number[] = [];
        let idx = maxIdx;
        while (idx !== -1) {
            result.push(idx);
            idx = parent[idx];
        }
        result.reverse();

        return result;
    }

    /**
     * Positional diff: matches lines by position, not by content similarity.
     * This is the key difference from LCS - it prevents cross-matching similar lines
     * from different code blocks.
     * 
     * When block sizes differ, we first check if the content aligns at the start
     * or end (indicating simple deletion), before falling back to pure removed+added.
     */
    private positionalDiff(
        oldLines: string[],
        oldStart: number,
        oldEnd: number,
        newLines: string[],
        newStart: number,
        newEnd: number
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        const oldLen = oldEnd - oldStart;
        const newLen = newEnd - newStart;
        const result: Array<{ value: string[]; added?: boolean; removed?: boolean }> = [];

        // If one side is empty, return pure add or remove
        if (oldLen === 0 && newLen > 0) {
            return [{ value: newLines.slice(newStart, newEnd), added: true }];
        }
        if (newLen === 0 && oldLen > 0) {
            return [{ value: oldLines.slice(oldStart, oldEnd), removed: true }];
        }

        // Check if this is a deletion at the START (old ends match new)
        // i.e., new content is a suffix of old content
        if (oldLen > newLen) {
            const diff = oldLen - newLen;
            let suffixMatch = true;
            for (let i = 0; i < newLen; i++) {
                if (oldLines[oldStart + diff + i] !== newLines[newStart + i]) {
                    suffixMatch = false;
                    break;
                }
            }
            if (suffixMatch) {
                // Lines at start were deleted, rest unchanged
                result.push({ value: oldLines.slice(oldStart, oldStart + diff), removed: true });
                result.push({ value: oldLines.slice(oldStart + diff, oldEnd) });
                return result;
            }
        }

        // Check if this is a deletion at the END (old starts match new)
        // i.e., new content is a prefix of old content
        if (oldLen > newLen) {
            const diff = oldLen - newLen;
            let prefixMatch = true;
            for (let i = 0; i < newLen; i++) {
                if (oldLines[oldStart + i] !== newLines[newStart + i]) {
                    prefixMatch = false;
                    break;
                }
            }
            if (prefixMatch) {
                // Lines at end were deleted, start unchanged
                result.push({ value: oldLines.slice(oldStart, oldStart + newLen) });
                result.push({ value: oldLines.slice(oldStart + newLen, oldEnd), removed: true });
                return result;
            }
        }

        // Check if this is an addition at the START (new ends match old)
        if (newLen > oldLen) {
            const diff = newLen - oldLen;
            let suffixMatch = true;
            for (let i = 0; i < oldLen; i++) {
                if (newLines[newStart + diff + i] !== oldLines[oldStart + i]) {
                    suffixMatch = false;
                    break;
                }
            }
            if (suffixMatch) {
                result.push({ value: newLines.slice(newStart, newStart + diff), added: true });
                result.push({ value: newLines.slice(newStart + diff, newEnd) });
                return result;
            }
        }

        // Check if this is an addition at the END (new starts match old)
        if (newLen > oldLen) {
            const diff = newLen - oldLen;
            let prefixMatch = true;
            for (let i = 0; i < oldLen; i++) {
                if (newLines[newStart + i] !== oldLines[oldStart + i]) {
                    prefixMatch = false;
                    break;
                }
            }
            if (prefixMatch) {
                result.push({ value: newLines.slice(newStart, newStart + oldLen) });
                result.push({ value: newLines.slice(newStart + oldLen, newEnd), added: true });
                return result;
            }
        }

        // No simple prefix/suffix match - fall back to finding leading/trailing unchanged
        const minLen = Math.min(oldLen, newLen);

        let leadingUnchanged = 0;
        while (leadingUnchanged < minLen &&
            oldLines[oldStart + leadingUnchanged] === newLines[newStart + leadingUnchanged]) {
            leadingUnchanged++;
        }

        if (leadingUnchanged > 0) {
            result.push({ value: oldLines.slice(oldStart, oldStart + leadingUnchanged) });
        }

        let trailingUnchanged = 0;
        while (trailingUnchanged < minLen - leadingUnchanged &&
            oldLines[oldEnd - 1 - trailingUnchanged] === newLines[newEnd - 1 - trailingUnchanged]) {
            trailingUnchanged++;
        }

        const oldMiddleStart = oldStart + leadingUnchanged;
        const oldMiddleEnd = oldEnd - trailingUnchanged;
        const newMiddleStart = newStart + leadingUnchanged;
        const newMiddleEnd = newEnd - trailingUnchanged;

        if (oldMiddleStart < oldMiddleEnd) {
            result.push({ value: oldLines.slice(oldMiddleStart, oldMiddleEnd), removed: true });
        }
        if (newMiddleStart < newMiddleEnd) {
            result.push({ value: newLines.slice(newMiddleStart, newMiddleEnd), added: true });
        }

        if (trailingUnchanged > 0) {
            result.push({ value: oldLines.slice(oldEnd - trailingUnchanged, oldEnd) });
        }

        return result;
    }

    /**
     * Merge consecutive changes of the same type for cleaner output.
     */
    private mergeConsecutiveChanges(
        changes: Array<{ value: string[]; added?: boolean; removed?: boolean }>
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        if (changes.length === 0) {
            return [];
        }

        const result: Array<{ value: string[]; added?: boolean; removed?: boolean }> = [];

        for (const change of changes) {
            if (change.value.length === 0) {
                continue;
            }

            const last = result[result.length - 1];
            if (last &&
                last.added === change.added &&
                last.removed === change.removed) {
                last.value.push(...change.value);
            } else {
                result.push({ ...change, value: [...change.value] });
            }
        }

        return result;
    }

    private normalizeLineForMatch(input: string | undefined): string {
        let value = (input ?? '').trim();

        value = value.replace(/^\/\/\s?/, '');
        value = value.replace(/^#\s?/, '');
        value = value.replace(/^--\s?/, '');
        value = value.replace(/^\/\*\s?/, '');
        value = value.replace(/\*\/\s?$/, '');
        value = value.replace(/\s+/g, ' ');

        return value.trim();
    }

    private setTrackedChange(filePath: string, diff: FileDiff): void {
        this.trackedChanges.set(filePath, diff);
        this.markTrackedChangesDirty();
    }

    private deleteTrackedChange(filePath: string): void {
        if (this.trackedChanges.delete(filePath)) {
            this.markTrackedChangesDirty();
        }
    }

    private clearTrackedChanges(): void {
        if (this.trackedChanges.size === 0) {
            return;
        }
        this.trackedChanges.clear();
        this.markTrackedChangesDirty();
    }

    private markTrackedChangesDirty(): void {
        this.trackedChangesVersion++;
    }

    private bumpLineChangesVersion(filePath: string): number {
        const current = this.lineChangesVersionByFile.get(filePath) ?? 0;
        const next = current + 1;
        this.lineChangesVersionByFile.set(filePath, next);
        return next;
    }

    private invalidateChangeBlocksCache(filePath: string): void {
        this.changeBlocksCache.delete(filePath);
    }

    private resetChangeBlocksCaches(): void {
        this.changeBlocksCache.clear();
        this.lineChangesVersionByFile.clear();
    }

    private markLineChangesUpdated(filePath: string): void {
        this.bumpLineChangesVersion(filePath);
        this.invalidateChangeBlocksCache(filePath);
    }

    private emitTrackChangesEvent(event: Partial<TrackChangesEvent>): void {
        const normalizeFiles = (files: string[] | undefined): string[] => {
            if (!files || files.length === 0) {
                return [];
            }
            return [...new Set(files)];
        };

        this._onDidTrackChanges.fire({
            changedFiles: normalizeFiles(event.changedFiles),
            removedFiles: normalizeFiles(event.removedFiles),
            fullRefresh: event.fullRefresh === true,
            baselineChanged: event.baselineChanged === true
        });
    }

    private setIgnoreResultCache(cacheKey: string, ignored: boolean): void {
        this.ignoreResultCache.set(cacheKey, ignored);
        if (this.ignoreResultCache.size <= this.ignoreResultCacheMaxEntries) {
            return;
        }

        const oldestKey = this.ignoreResultCache.keys().next().value as string | undefined;
        if (oldestKey !== undefined) {
            this.ignoreResultCache.delete(oldestKey);
        }
    }

    public dispose() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
            void this.flushPersistState();
        }
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.clearAutomationSessions();
        this.disposeFileWatchers();
        this.disposables.forEach(d => d.dispose());
        this._onDidChangeRecordingState.dispose();
        this._onDidTrackChanges.dispose();
        this._onDidChangeBaselineState.dispose();
    }
}
