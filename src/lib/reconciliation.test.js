import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findReconciliationJob,
  reconciliationKnownIdMatches,
  reconciliationTargetForJob,
} from './reconciliation.js';

test('reconciliation target is fixed by the ambiguous durable job type', () => {
  const job = findReconciliationJob([
    { id: 9, type: 'publish_reply', result: { phase: 'needs_reconciliation' } },
    { id: 8, type: 'publish_post', result: { phase: 'unrelated_failure' } },
  ]);

  assert.equal(job.id, 9);
  assert.equal(reconciliationTargetForJob(job), 'reply');
});

test('a known Meta post ID cannot be replaced or marked not published', () => {
  const job = {
    result: { phase: 'needs_reconciliation', details: { knownExternalId: 'meta-123' } },
  };
  assert.equal(reconciliationKnownIdMatches(job, 'published', 'meta-123'), true);
  assert.equal(reconciliationKnownIdMatches(job, 'published', 'other-id'), false);
  assert.equal(reconciliationKnownIdMatches(job, 'not_published', null), false);
});

test('a reclaimed publish-start marker also requires its original target', () => {
  const job = findReconciliationJob([
    { id: 4, type: 'publish_post', result: { phase: 'threads_publish_started' } },
  ]);

  assert.equal(reconciliationTargetForJob(job), 'main');
  assert.equal(findReconciliationJob([{ result: { phase: 'failed' } }]), null);
});
