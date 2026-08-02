import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBackoffMs, parseRetryAfter } from '../src/backoff.js';

test('uses exponential full jitter and respects Retry-After as a floor', () => {
  assert.equal(calculateBackoffMs({ attempt: 3, baseMs: 1_000, maxMs: 60_000, random: () => 0.5 }), 2_000);
  assert.equal(calculateBackoffMs({
    attempt: 3,
    retryAfterMs: 10_000,
    baseMs: 1_000,
    maxMs: 60_000,
    random: () => 0.5,
  }), 10_000);
});

test('parses both Retry-After seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('12'), 12_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', Date.parse('2026-01-01T00:00:00Z')), 10_000);
});
