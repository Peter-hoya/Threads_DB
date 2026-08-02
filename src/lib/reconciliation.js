const RECONCILIATION_PHASES = new Set([
  'needs_reconciliation',
  'threads_publish_started',
]);

export function findReconciliationJob(jobs) {
  return (jobs || []).find((job) => RECONCILIATION_PHASES.has(job?.result?.phase)) || null;
}

export function reconciliationTargetForJob(job) {
  if (!job) return null;
  if (job.type === 'publish_reply') return 'reply';
  if (job.type === 'publish_post') return 'main';
  return null;
}

export function reconciliationKnownIdMatches(job, outcome, externalId) {
  const knownExternalId = job?.result?.details?.knownExternalId;
  if (!knownExternalId) return true;
  return outcome === 'published' && String(externalId) === String(knownExternalId);
}
