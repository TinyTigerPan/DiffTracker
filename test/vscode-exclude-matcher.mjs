import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    VSCodeExcludeMatcher,
    collectEnabledVSCodeExcludePatterns,
    resolveVSCodeExcludeSourceEnabled
} = require('../out/vscodeExcludeMatcher.js');

function runCase(name, fn) {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (error) {
        console.error(`FAIL ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

function isEnabled(defaultValue, explicitValue, legacyExplicitValue) {
    return resolveVSCodeExcludeSourceEnabled({
        legacyExplicitValue,
        source: {
            defaultValue,
            explicitValue
        }
    });
}

runCase('default source selection applies files excludes only', () => {
    assert.equal(isEnabled(true, undefined, undefined), true);
    assert.equal(isEnabled(false, undefined, undefined), false);
});

runCase('search and watcher sources can be explicitly enabled', () => {
    assert.equal(isEnabled(false, true, undefined), true);
    assert.equal(isEnabled(false, true, false), true);
});

runCase('legacy false disables unspecified source settings', () => {
    assert.equal(isEnabled(true, undefined, false), false);
    assert.equal(isEnabled(false, undefined, false), false);
    assert.equal(isEnabled(true, true, false), true);
    assert.equal(isEnabled(true, false, false), false);
});

runCase('collects only boolean true exclude patterns', () => {
    const patterns = collectEnabledVSCodeExcludePatterns({
        '**/dist': true,
        '**/obj': false,
        '**/*.js': { when: '$(basename).ts' },
        '': true
    });

    assert.deepEqual(patterns, ['**/dist']);
});

runCase('invalid glob patterns are ignored', () => {
    const matcher = new VSCodeExcludeMatcher(['[z-a]', '**/valid'], true);

    assert.equal(matcher.ignores('anything'), false);
    assert.equal(matcher.ignores('src/valid/file.txt'), true);
});

runCase('workspace-relative patterns match root and nested paths correctly', () => {
    const matcher = new VSCodeExcludeMatcher(['*.log', 'src/**', '**/dist'], true);

    assert.equal(matcher.ignores('app.log'), true);
    assert.equal(matcher.ignores('nested/app.log'), false);
    assert.equal(matcher.ignores('src/app.ts'), true);
    assert.equal(matcher.ignores('lib/src/app.ts'), false);
    assert.equal(matcher.ignores('packages/tool/dist/index.js'), true);
});

runCase('glob operators match the supported VS Code subset', () => {
    const matcher = new VSCodeExcludeMatcher([
        '{**/*.html,**/*.txt}',
        '**/file?.[ch]',
        '**/asset.[!0-9]'
    ], true);

    assert.equal(matcher.ignores('index.html'), true);
    assert.equal(matcher.ignores('docs/readme.txt'), true);
    assert.equal(matcher.ignores('src/file1.c'), true);
    assert.equal(matcher.ignores('src/file12.c'), false);
    assert.equal(matcher.ignores('asset.a'), true);
    assert.equal(matcher.ignores('asset.1'), false);
});

runCase('case sensitivity follows the selected platform mode', () => {
    const insensitive = new VSCodeExcludeMatcher(['**/Generated/**'], false);
    const sensitive = new VSCodeExcludeMatcher(['**/Generated/**'], true);

    assert.equal(insensitive.ignores('src/generated/file.cs'), true);
    assert.equal(sensitive.ignores('src/generated/file.cs'), false);
    assert.equal(sensitive.ignores('src/Generated/file.cs'), true);
});
