export class WorkerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = options.code || 'WORKER_ERROR';
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.details = options.details;
  }
}

export class RetryableError extends WorkerError {
  constructor(message, options = {}) {
    super(message, { ...options, retryable: true });
  }
}

export class PermanentError extends WorkerError {
  constructor(message, options = {}) {
    super(message, { ...options, retryable: false });
  }
}

export class LostLeaseError extends RetryableError {
  constructor(message = 'Job lease is no longer owned by this worker.') {
    super(message, { code: 'LOST_LEASE' });
  }
}

export class DeferredError extends WorkerError {
  constructor(message, runAt, options = {}) {
    super(message, { ...options, retryable: false, code: options.code || 'JOB_DEFERRED' });
    this.runAt = runAt;
  }
}

export class ReconciliationRequiredError extends PermanentError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'PUBLISH_RECONCILIATION_REQUIRED',
    });
    this.reconciliationRequired = true;
  }
}

export function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
