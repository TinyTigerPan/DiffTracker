export type VSCodeExcludeSource = 'files' | 'search' | 'watcher';

export interface VSCodeExcludeSourceOption {
    defaultValue: boolean;
    explicitValue: boolean | undefined;
}

export interface VSCodeExcludeCompatibilityOptions {
    legacyExplicitValue?: boolean;
    source: VSCodeExcludeSourceOption;
}

interface CompiledPattern {
    segments: RegExp[];
}

export class VSCodeExcludeMatcher {
    private readonly patterns: CompiledPattern[];

    constructor(patterns: string[], private readonly caseSensitive: boolean) {
        this.patterns = patterns
            .flatMap(pattern => expandBraces(normalizePattern(pattern)))
            .map(pattern => compilePattern(pattern, caseSensitive))
            .filter((pattern): pattern is CompiledPattern => pattern !== undefined);
    }

    public ignores(relativePath: string): boolean {
        const normalized = normalizePath(relativePath, this.caseSensitive);
        if (!normalized) {
            return false;
        }

        const targets = getPathAndParentDirectories(normalized);
        return this.patterns.some(pattern =>
            targets.some(target => matchesSegments(pattern.segments, target.split('/'), 0, 0))
        );
    }
}

export function collectEnabledVSCodeExcludePatterns(excludes: Record<string, unknown> | undefined): string[] {
    if (!excludes) {
        return [];
    }

    return Object.entries(excludes)
        .filter((entry): entry is [string, true] => entry[1] === true && entry[0].trim().length > 0)
        .map(([pattern]) => pattern);
}

export function resolveVSCodeExcludeSourceEnabled(options: VSCodeExcludeCompatibilityOptions): boolean {
    const explicitValue = options.source.explicitValue;
    if (explicitValue !== undefined) {
        return explicitValue;
    }

    if (options.legacyExplicitValue === false) {
        return false;
    }

    return options.source.defaultValue;
}

function normalizePattern(pattern: string): string {
    let normalized = pattern.trim().replace(/\\/g, '/');
    if (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    while (normalized.startsWith('/')) {
        normalized = normalized.slice(1);
    }
    while (normalized.endsWith('/') && normalized.length > 1) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

function normalizePath(value: string, caseSensitive: boolean): string {
    let normalized = value.trim().replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    while (normalized.startsWith('/')) {
        normalized = normalized.slice(1);
    }
    while (normalized.endsWith('/') && normalized.length > 1) {
        normalized = normalized.slice(0, -1);
    }
    return caseSensitive ? normalized : normalized.toLowerCase();
}

function getPathAndParentDirectories(relativePath: string): string[] {
    const targets = [relativePath];
    let current = relativePath;
    while (current.includes('/')) {
        current = current.slice(0, current.lastIndexOf('/'));
        if (current) {
            targets.push(current);
        }
    }
    return targets;
}

function expandBraces(pattern: string): string[] {
    const openIndex = pattern.indexOf('{');
    if (openIndex === -1) {
        return [pattern];
    }

    const closeIndex = findMatchingBrace(pattern, openIndex);
    if (closeIndex === -1) {
        return [pattern];
    }

    const before = pattern.slice(0, openIndex);
    const after = pattern.slice(closeIndex + 1);
    const alternatives = splitBraceAlternatives(pattern.slice(openIndex + 1, closeIndex));
    return alternatives.flatMap(alternative => expandBraces(`${before}${alternative}${after}`));
}

function findMatchingBrace(pattern: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

function splitBraceAlternatives(value: string): string[] {
    const alternatives: string[] = [];
    let depth = 0;
    let start = 0;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
        } else if (char === ',' && depth === 0) {
            alternatives.push(value.slice(start, i));
            start = i + 1;
        }
    }

    alternatives.push(value.slice(start));
    return alternatives;
}

function compilePattern(pattern: string, caseSensitive: boolean): CompiledPattern | undefined {
    const normalized = normalizePath(pattern, caseSensitive);
    if (!normalized) {
        return undefined;
    }

    try {
        const segments = normalized
            .split('/')
            .filter(segment => segment.length > 0)
            .map(segment => segment === '**' ? /^.*$/ : compileSegment(segment));

        return { segments };
    } catch {
        return undefined;
    }
}

function compileSegment(segment: string): RegExp {
    let source = '^';

    for (let i = 0; i < segment.length; i++) {
        const char = segment[i];

        if (char === '*') {
            source += '[^/]*';
            continue;
        }

        if (char === '?') {
            source += '[^/]';
            continue;
        }

        if (char === '[') {
            const closeIndex = segment.indexOf(']', i + 1);
            if (closeIndex !== -1) {
                const content = segment.slice(i + 1, closeIndex);
                if (content.length > 0) {
                    source += content.startsWith('!')
                        ? `[^${escapeCharacterClass(content.slice(1))}]`
                        : `[${escapeCharacterClass(content)}]`;
                    i = closeIndex;
                    continue;
                }
            }
        }

        source += escapeRegex(char);
    }

    source += '$';
    return new RegExp(source);
}

function escapeRegex(value: string): string {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function escapeCharacterClass(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function matchesSegments(
    patternSegments: RegExp[],
    pathSegments: string[],
    patternIndex: number,
    pathIndex: number
): boolean {
    if (patternIndex === patternSegments.length) {
        return pathIndex === pathSegments.length;
    }

    const pattern = patternSegments[patternIndex];
    if (pattern.source === '^.*$') {
        for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex++) {
            if (matchesSegments(patternSegments, pathSegments, patternIndex + 1, nextPathIndex)) {
                return true;
            }
        }
        return false;
    }

    if (pathIndex >= pathSegments.length) {
        return false;
    }

    return pattern.test(pathSegments[pathIndex]) &&
        matchesSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1);
}
