import assert from 'node:assert/strict';
import test from 'node:test';
import { googleMapsDirectionsUrl } from '../src/lib/client/maps-directions.ts';

const origin = { latitude: 35.69, longitude: 139.7 };
const destination = {
    latitude: 35.685,
    longitude: 139.71,
    placeId: 'test-destination',
    label: 'テスト用の目的地',
};
const stop = {
    latitude: 35.688,
    longitude: 139.705,
    placeId: 'test-stop',
    label: 'テスト用の寄り道',
};
test('direct walking directions specify both endpoints and omit the waypoint', () => {
    const url = new URL(googleMapsDirectionsUrl({ origin, destination }));
    assert.equal(url.origin, 'https://www.google.com');
    assert.equal(url.pathname, '/maps/dir/');
    assert.equal(url.searchParams.get('api'), '1');
    assert.equal(url.searchParams.get('travelmode'), 'walking');
    assert.equal(url.searchParams.get('origin'), '35.69,139.7');
    assert.equal(url.searchParams.get('destination'), destination.label);
    assert.equal(url.searchParams.get('destination_place_id'), destination.placeId);
    assert.equal(url.searchParams.has('waypoints'), false);
    assert.equal(url.searchParams.has('waypoint_place_ids'), false);
});
test('a detour preserves the chosen stop as a waypoint before the destination', () => {
    const url = new URL(googleMapsDirectionsUrl({ origin, destination, stop }));
    assert.equal(url.searchParams.get('waypoints'), stop.label);
    assert.equal(url.searchParams.get('waypoint_place_ids'), stop.placeId);
    assert.equal(url.searchParams.get('destination_place_id'), destination.placeId);
});
test('manual origins keep their place identity alongside the required origin text', () => {
    const url = new URL(
        googleMapsDirectionsUrl({
            origin,
            originPlaceId: 'test-origin',
            originLabel: 'テスト出発地',
            destination,
            stop,
        }),
    );
    assert.equal(url.searchParams.get('origin_place_id'), 'test-origin');
    assert.equal(url.searchParams.get('origin'), 'テスト出発地');
});
test('recalculation uses the updated origin instead of the original search location', () => {
    const latestOrigin = { latitude: 35.691, longitude: 139.701 };
    const url = new URL(googleMapsDirectionsUrl({ origin: latestOrigin, destination, stop }));
    assert.equal(url.searchParams.get('origin'), '35.691,139.701');
});
test('after completing the stop, it becomes the origin and is not retained as a waypoint', () => {
    const url = new URL(
        googleMapsDirectionsUrl({
            origin: stop,
            originPlaceId: stop.placeId,
            originLabel: stop.label,
            destination,
            stop: null,
        }),
    );
    assert.equal(url.searchParams.get('origin_place_id'), stop.placeId);
    assert.equal(url.searchParams.get('origin'), stop.label);
    assert.equal(url.searchParams.has('waypoints'), false);
});
test('GPS origins use explicit coordinates even when their UI label says current location', () => {
    const url = new URL(googleMapsDirectionsUrl({ origin, originLabel: '現在地', destination }));
    assert.equal(url.searchParams.get('origin'), '35.69,139.7');
});
test('a pipe in a display label cannot introduce an extra waypoint', () => {
    const url = new URL(
        googleMapsDirectionsUrl({ origin, destination, stop: { ...stop, label: '施設A|施設B' } }),
    );
    assert.equal(url.searchParams.get('waypoints'), '35.688,139.705');
    assert.equal(url.searchParams.get('waypoint_place_ids'), stop.placeId);
});
test('missing or invalid coordinates never fall back to an implicit device location', () => {
    for (const point of [
        undefined,
        null,
        { latitude: NaN, longitude: 139.7 },
        { latitude: 91, longitude: 0 },
        { latitude: 0, longitude: Infinity },
        { latitude: 0, longitude: -181 },
    ]) {
        assert.equal(googleMapsDirectionsUrl({ origin: point, destination }), null);
    }
    assert.equal(
        googleMapsDirectionsUrl({ origin, destination: { ...destination, latitude: NaN } }),
        null,
    );
    assert.equal(
        googleMapsDirectionsUrl({ origin, destination, stop: { ...stop, longitude: 181 } }),
        null,
    );
});
test('invalid place identifiers cannot alter the intended route or query', () => {
    for (const id of ['', 'x'.repeat(257), 'a|b', 'a&key=fake', '../places/other']) {
        assert.equal(
            googleMapsDirectionsUrl({ origin, destination: { ...destination, placeId: id } }),
            null,
        );
        assert.equal(
            googleMapsDirectionsUrl({ origin, destination, stop: { ...stop, placeId: id } }),
            null,
        );
        assert.equal(googleMapsDirectionsUrl({ origin, originPlaceId: id, destination }), null);
    }
});
test('the URL contains only routing parameters and stays within the Maps URL limit', () => {
    const href = googleMapsDirectionsUrl({
        origin,
        originPlaceId: 'o'.repeat(256),
        destination: { ...destination, placeId: 'd'.repeat(256), label: '長い名称'.repeat(500) },
        stop: { ...stop, placeId: 's'.repeat(256) },
        optionToken: 'test-only-token',
        arriveBy: '2026-11-09T00:00:00Z',
    });
    const url = new URL(href);
    assert.deepEqual(
        [...url.searchParams.keys()].sort(),
        [
            'api',
            'origin',
            'origin_place_id',
            'destination',
            'destination_place_id',
            'travelmode',
            'waypoints',
            'waypoint_place_ids',
        ].sort(),
    );
    assert.ok(href.length <= 2048);
    assert.ok(!href.includes('test-only-token'));
});
