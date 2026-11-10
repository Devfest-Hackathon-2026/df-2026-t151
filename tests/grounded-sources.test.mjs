import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const source = await readFile(
    new URL('../src/components/grounded-sources.tsx', import.meta.url),
    'utf8',
);
await loadBindings();
const { code: compiled } = await transform(source, {
    filename: 'grounded-sources.tsx',
    jsc: {
        parser: { syntax: 'typescript', tsx: true },
        target: 'es2022',
        transform: { react: { runtime: 'automatic' } },
    },
    module: { type: 'commonjs' },
});
const componentModule = { exports: {} };
runInNewContext(compiled, {
    exports: componentModule.exports,
    require: createRequire(import.meta.url),
    URL,
});
const render = (sources) =>
    renderToStaticMarkup(createElement(componentModule.exports.GroundedSources, { sources }));
test('discloses AI grounding and exposes source titles and original HTTPS links in one interaction', () => {
    const html = render([
        { provider: 'Google Maps：架空の彫刻', url: 'https://maps.google.com/?cid=demo' },
    ]);
    assert.ok(html.includes('を参照したAIによる提案'));
    assert.ok(html.includes('<details>'));
    assert.ok(html.includes('架空の彫刻'));
    assert.ok(html.includes('https://maps.google.com/?cid=demo'));
    assert.ok(html.includes('translate="no"'));
    assert.ok(html.includes('white-space:nowrap'));
});
test('does not render unsafe links or treat external titles as HTML', () => {
    const html = render([
        { provider: 'Google Maps：bad', url: 'javascript:alert(1)' },
        { provider: 'Google Maps：<img src=x onerror=alert(1)>', url: 'https://maps.google.com/' },
    ]);
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.equal(render([{ provider: '開発用の架空データ', url: null }]), '');
});
