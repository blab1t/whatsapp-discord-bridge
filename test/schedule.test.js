import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../src/when.js';

const NOW = new Date(2026, 8, 6, 12, 0, 0); // 2026-09-06 12:00 local

test('relative offsets', () => {
  assert.equal(parseWhen('in 30m', NOW).getTime(), NOW.getTime() + 30 * 60_000);
  assert.equal(parseWhen('in 2h', NOW).getTime(), NOW.getTime() + 2 * 3600_000);
  assert.equal(parseWhen('in 3d', NOW).getTime(), NOW.getTime() + 3 * 86400_000);
  assert.equal(parseWhen('in 1w', NOW).getTime(), NOW.getTime() + 7 * 86400_000);
  assert.equal(parseWhen('IN 45 minutes', NOW).getTime(), NOW.getTime() + 45 * 60_000);
});

test('today and tomorrow', () => {
  assert.deepEqual(parseWhen('today 18:30', NOW), new Date(2026, 8, 6, 18, 30));
  assert.deepEqual(parseWhen('tomorrow 09:00', NOW), new Date(2026, 8, 7, 9, 0));
});

test('bare time rolls to tomorrow once past', () => {
  assert.deepEqual(parseWhen('18:30', NOW), new Date(2026, 8, 6, 18, 30));
  assert.deepEqual(parseWhen('09:00', NOW), new Date(2026, 8, 7, 9, 0));
});

test('absolute date', () => {
  assert.deepEqual(parseWhen('2026-09-08 14:30', NOW), new Date(2026, 8, 8, 14, 30));
});

test('past times are rejected, not silently shifted', () => {
  assert.throws(() => parseWhen('today 09:00', NOW), /already past/);
  assert.throws(() => parseWhen('2020-01-01 10:00', NOW), /already past/);
  assert.throws(() => parseWhen('in 0m', NOW), /not in the future/);
});

test('garbage is rejected with help text', () => {
  assert.throws(() => parseWhen('whenever', NOW), /Accepted forms/);
  assert.throws(() => parseWhen('', NOW), /Accepted forms/);
  assert.throws(() => parseWhen('in a bit', NOW), /Accepted forms/);
});
