import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('content reuse cooldown defaults to 90 days and stays within the shared admin bounds', () => {
  const original = process.env.CONTENT_REUSE_COOLDOWN_DAYS;
  try {
    delete process.env.CONTENT_REUSE_COOLDOWN_DAYS;
    assert.equal(loadConfig().contentReuseCooldownDays, 90);
    process.env.CONTENT_REUSE_COOLDOWN_DAYS = '365';
    assert.equal(loadConfig().contentReuseCooldownDays, 365);
    process.env.CONTENT_REUSE_COOLDOWN_DAYS = '0';
    assert.throws(() => loadConfig(), /CONTENT_REUSE_COOLDOWN_DAYS/);
  } finally {
    if (original === undefined) delete process.env.CONTENT_REUSE_COOLDOWN_DAYS;
    else process.env.CONTENT_REUSE_COOLDOWN_DAYS = original;
  }
});
