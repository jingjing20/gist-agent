import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function styleRule(file, selector) {
    const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `${file}: missing ${selector} style rule`);
    return match[1];
}

const themedTextRules = [
    ['ChatSidebar.vue', '.active .conv-title'],
    ['ChatEmptyState.vue', '.expand-sidebar-btn:hover'],
    ['ChatDetail.vue', '.chat-title'],
    ['ChatDetail.vue', '.toolbar-btn:hover'],
    ['DataSourceDrawer.vue', '.drawer-title'],
    ['DataSourceDrawer.vue', '.drawer-toggle:hover'],
    ['DataSourceDrawer.vue', '.table-item.active'],
];

for (const [file, selector] of themedTextRules) {
    assert.match(
        styleRule(file, selector),
        /color:\s*var\(--da-text-main\)\s*;/,
        `${file}: ${selector} must use the theme-aware main text color`,
    );
}

assert.match(
    styleRule('ChatSidebar.vue', '.conversation-item:hover'),
    /background:\s*var\(--da-card\)\s*;/,
    'ChatSidebar.vue: conversation hover background must remain visible in both themes',
);

assert.match(
    styleRule('DataSourceDrawer.vue', '.table-item:hover'),
    /background:\s*var\(--da-border\)\s*;/,
    'DataSourceDrawer.vue: table hover background must remain visible in both themes',
);

assert.match(
    styleRule('ChatDetail.vue', '.latest-button'),
    /background:\s*var\(--da-panel\)\s*;/,
    'ChatDetail.vue: latest-message button must use a theme-aware surface',
);

assert.match(
    styleRule('DataSourceDrawer.vue', '.ds-card'),
    /background:\s*var\(--da-card\)\s*;/,
    'DataSourceDrawer.vue: datasource cards must use a theme-aware surface',
);

assert.match(
    styleRule('DataSourceDrawer.vue', '.ds-card'),
    /border:\s*1px\s+solid\s+var\(--da-border\)\s*;/,
    'DataSourceDrawer.vue: datasource card borders must use the theme border',
);

console.log('Theme style checks passed.');
