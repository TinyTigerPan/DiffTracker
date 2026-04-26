import * as vscode from 'vscode';

/**
 * Tree item for a setting toggle
 */
class SettingItem extends vscode.TreeItem {
    constructor(
        public readonly settingKey: string,
        public readonly label: string,
        public readonly isEnabled: boolean
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        // Use checkbox-style icons
        this.iconPath = new vscode.ThemeIcon(isEnabled ? 'check' : 'circle-large-outline');
        this.description = isEnabled ? 'On' : 'Off';
        this.contextValue = 'settingItem';
        this.command = {
            command: 'diffTracker.toggleSetting',
            title: 'Toggle Setting',
            arguments: [settingKey]
        };
        this.tooltip = `Click to ${isEnabled ? 'disable' : 'enable'}`;
    }
}

/**
 * Tree item for a setting group
 */
class SettingGroupItem extends vscode.TreeItem {
    constructor(
        public readonly label: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('settings');
        this.contextValue = 'settingGroup';
    }
}

/**
 * Tree item for an action entry
 */
class SettingActionItem extends vscode.TreeItem {
    constructor(public readonly label: string, command: vscode.Command, iconId: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(iconId);
        this.command = command;
        this.contextValue = 'settingAction';
    }
}

type SettingGroup = {
    id: string;
    label: string;
    icon?: string;
    items: Array<{ key: string; label: string }>;
};

/**
 * Provides the settings tree view in the sidebar
 */
export class SettingsTreeDataProvider implements vscode.TreeDataProvider<SettingItem | SettingGroupItem | SettingActionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SettingItem | SettingGroupItem | SettingActionItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private configurationChangeDisposable: vscode.Disposable;

    private settings: SettingGroup[] = [
        {
            id: 'display',
            label: 'Display',
            items: [
                { key: 'openWebviewBeside', label: 'Beside View' },
                { key: 'showFullFilePaths', label: 'Show Full File Paths' },
                { key: 'showDeletedLinesBadge', label: 'Deleted line badge' },
                { key: 'showCodeLens', label: 'CodeLens actions' }
            ]
        },
        {
            id: 'highlight',
            label: 'Highlight',
            items: [
                { key: 'highlightAddedLines', label: 'Added lines' },
                { key: 'highlightModifiedLines', label: 'Modified lines' },
                { key: 'highlightWordChanges', label: 'Word changes' }
            ]
        },
        {
            id: 'ignores',
            label: 'Ignores',
            items: [
                { key: 'useGitIgnoreExcludes', label: 'Use .gitignore rules' },
                { key: 'useBuiltInExcludes', label: 'Use built-in ignores' },
                { key: 'useVSCodeExcludes', label: 'Use VS Code excludes' }
            ]
        },
        {
            id: 'recording',
            label: 'Recording',
            items: [
                { key: 'onlyTrackAutomatedChanges', label: 'Vibe Coding Only' }
            ]
        },
        {
            id: 'safety',
            label: 'Safety',
            items: [
                { key: 'confirmReversions', label: 'Confirm reversions' }
            ]
        },
        {
            id: 'tools',
            label: 'Tools',
            items: []
        }
    ];

    constructor() {
        // Refresh when settings change
        this.configurationChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('diffTracker')) {
                this.refresh();
            }
        });
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SettingItem | SettingGroupItem | SettingActionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SettingGroupItem): Array<SettingGroupItem | SettingItem | SettingActionItem> {
        const config = vscode.workspace.getConfiguration('diffTracker');

        if (!element) {
            return this.settings.map(group => new SettingGroupItem(group.label));
        }

        const group = this.settings.find(g => g.label === element.label);
        if (!group) {
            return [];
        }

        if (group.id === 'tools') {
            return [
                new SettingActionItem(
                    'Edit Watch Ignores',
                    {
                        command: 'diffTracker.editWatchExcludes',
                        title: 'Edit Watch Ignores'
                    },
                    'filter'
                )
            ];
        }

        if (group.id === 'display') {
            const defaultOpenMode = config.get<string>('defaultOpenMode', 'webview');
            const modeLabelMap: { [key: string]: string } = {
                webview: 'Webview',
                inline: 'Inline (read-only)',
                sideBySide: 'Side-by-Side',
                original: 'Original',
                splitOriginalWebview: 'Split: Original | Webview'
            };
            const modeLabel = modeLabelMap[defaultOpenMode] ?? 'Webview';

            return [
                new SettingActionItem(
                    `Default open mode: ${modeLabel}`,
                    {
                        command: 'diffTracker.selectDefaultOpenMode',
                        title: 'Select Default Open Mode'
                    },
                    'preview'
                ),
                ...group.items.map(setting => {
                    const value = config.get<boolean>(setting.key, true);
                    return new SettingItem(setting.key, setting.label, value);
                })
            ];
        }

        return group.items.map(setting => {
            const value = config.get<boolean>(setting.key, true);
            return new SettingItem(setting.key, setting.label, value);
        });
    }

    /**
     * Toggle a setting
     */
    public async toggleSetting(settingKey: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const currentValue = config.get<boolean>(settingKey, true);
        await config.update(settingKey, !currentValue, vscode.ConfigurationTarget.Global);
        this.refresh();
    }

    public dispose(): void {
        this.configurationChangeDisposable.dispose();
        this._onDidChangeTreeData.dispose();
    }
}
