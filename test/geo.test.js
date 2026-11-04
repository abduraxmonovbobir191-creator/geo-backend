import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundingBox, haversine, trackStats } from '../src/lib/geo.js';

test('haversine: one degree of latitude is about 111.2 km', () => {
  assert.ok(Math.abs(haversine(0, 0, 1, 0) - 111_195) < 5);
  assert.equal(haversine(41.3, 69.2, 41.3, 69.2), 0);
});

test('boundingBox contains the radius in every direction', () => {
  const box = boundingBox(41.3, 69.24, 1_000);
  assert.ok(haversine(41.3, 69.24, box.maxLat, 69.24) >= 999);
  assert.ok(haversine(41.3, 69.24, 41.3, box.maxLng) >= 999);
});

const track = (pts) => pts.map(([lat, lng, s, ele]) => ({ lat, lng, t: s * 1000, ele }));
const north = (m) => m / 111_195;

test('trackStats: distance, duration, moving time and speed', () => {
  const stats = trackStats(track([[0, 0, 0], [north(100), 0, 30], [north(200), 0, 60]]));
  assert.ok(Math.abs(stats.distanceM - 200) < 0.5);
  assert.equal(stats.durationS, 60);
  assert.equal(stats.movingTimeS, 60);
  assert.ok(Math.abs(stats.avgSpeedMps - 200 / 60) < 0.01);
});

test('trackStats: standing still is not moving time', () => {
  const stats = trackStats(track([[0, 0, 0], [north(100), 0, 30], [north(100), 0, 330]]));
  assert.equal(stats.durationS, 330);
  assert.equal(stats.movingTimeS, 30);
});

test('trackStats: ignores GPS jumps that are impossibly fast', () => {
  const stats = trackStats(track([[0, 0, 0], [north(100), 0, 30], [1, 0, 31], [north(200), 0, 60]]));
  // The jump to latitude 1 and back are dropped; only the first 100 m segment counts.
  assert.ok(stats.distanceM < 150);
});

test('trackStats: elevation gain ignores small noise', () => {
  const points = track([[0, 0, 0, 100], [north(10), 0, 10, 101], [north(20), 0, 20, 100], [north(30), 0, 30, 110]]);
  assert.equal(trackStats(points).elevationGainM, 10);
});
