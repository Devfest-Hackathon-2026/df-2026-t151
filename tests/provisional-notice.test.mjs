import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';

test('candidate cards flag unknown opening and plans list every unconfirmed condition', async () => {
    await loadBindings();
    const filename = new URL('../src/components/option-estimate-notice.tsx', import.meta.url);
    const { code } = await transform(readFileSync(filename, 'utf8'), {
        filename: 'option-estimate-notice.tsx',
        jsc: {
            parser: { syntax: 'typescript', tsx: true },
            target: 'es2022',
            transform: { react: { runtime: 'automatic' } },
        },
        module: { type: 'commonjs' },
    });
    const module = { exports: {} };
    runInNewContext(code, { exports: module.exports, require: createRequire(import.meta.url) });
    const option = {
        time: { isProvisional: true },
        warnings: [
            { code: 'UNCONFIRMED_OPENING', message: '訪問時間帯の営業時間は不明です' },
            { code: 'UNCONFIRMED_BUSINESS_STATUS', message: '営業状態は不明です' },
            { code: 'UNCONFIRMED_RESERVATION', message: '予約なしで利用できるかは不明です' },
        ],
    };
    const card = renderToStaticMarkup(
        createElement(module.exports.OptionEstimateNotice, { option }),
    );
    assert.match(card, /営業時間は不明/);
    assert.match(card, /営業状態は不明/);
    assert.match(card, /行程画面で確認/);
    assert.ok(!card.includes('予約なしで利用できるかは不明'));
    const plan = renderToStaticMarkup(
        createElement(module.exports.OptionEstimateNotice, { option, showUnknownDetails: true }),
    );
    assert.match(plan, /予約なしで利用できるかは不明/);
    assert.match(plan, /利用前に確認が必要な不明事項/);
});
