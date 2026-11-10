import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyItineraryValidation, planFromSearch } from '../src/lib/client/trip-estimates.ts';

const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/search-success.json', import.meta.url), 'utf8'),
);
const selected = fixture.options[0];
const other = {
    ...selected,
    optionId: 'other-option',
    place: { ...selected.place, placeId: 'other-stop' },
};
const result = { ...fixture, options: [selected, other] };
const initialOrigin = { label: '現在地', coordinates: { latitude: 35.69, longitude: 139.7 } };
const search = { result, origin: initialOrigin };
const validation = {
    requestId: 'validate-001',
    calculatedAt: '2026-11-07T14:30:00+09:00',
    warnings: [],
    attributions: [],
};
const renewed = { ...selected, optionId: 'renewed-option', optionToken: 'renewed-token' };

test('a successful revalidation updates only the selected plan and its calculation time', () => {
    const { view } = applyItineraryValidation(search, initialOrigin, selected, {
        ...validation,
        status: 'VALID',
        option: renewed,
    });

    assert.equal(view.stage, 'plan');
    assert.equal(view.calculatedAt, validation.calculatedAt);
    assert.equal(view.option, renewed);
    assert.equal(view.search, search);
    assert.equal(view.search.result.calculatedAt, fixture.calculatedAt);
    assert.equal(view.search.result.direct, fixture.direct);
    assert.equal(view.search.result.options[1], other);
});

test('after a later revalidation fails, other candidates and direct departure use the original search', () => {
    const { view: plan } = applyItineraryValidation(search, initialOrigin, selected, {
        ...validation,
        status: 'VALID',
        option: renewed,
    });
    const { view } = applyItineraryValidation(plan.search, initialOrigin, plan.option, {
        ...validation,
        status: 'NO_LONGER_FEASIBLE',
        option: null,
    });

    assert.equal(view.stage, 'results');
    assert.equal(view.result.calculatedAt, fixture.calculatedAt);
    assert.deepEqual(view.result.options, [other]);
    const direct = planFromSearch(view, null);
    assert.equal(direct.calculatedAt, fixture.calculatedAt);
    assert.equal(direct.search.result.direct, fixture.direct);
    assert.equal(
        Date.parse(direct.calculatedAt) + direct.search.result.direct.durationSeconds * 1000,
        Date.parse(direct.search.result.direct.arrivalAt),
    );
});

test('a changed GPS origin is used for a valid plan but cannot reuse the previous search after failure', () => {
    const updatedOrigin = {
        ...initialOrigin,
        coordinates: { latitude: 35.691, longitude: 139.702 },
    };
    const { view: plan } = applyItineraryValidation(search, updatedOrigin, selected, {
        ...validation,
        status: 'VALID',
        option: renewed,
    });
    assert.equal(plan.origin, updatedOrigin);
    assert.equal(plan.search.origin, initialOrigin);
    const { view, notice } = applyItineraryValidation(plan.search, updatedOrigin, renewed, {
        ...validation,
        status: 'EXPIRED',
        option: null,
    });
    assert.deepEqual(view, { stage: 'input' });
    assert.match(notice, /更新した出発地点で検索/);
});
