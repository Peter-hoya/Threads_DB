import { calculateBackoffMs } from './backoff.js';
import { DeferredError, LostLeaseError, toErrorMessage } from './errors.js';
import { LeaseHeartbeat } from './lease-heartbeat.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PublishWorker {
  constructor({ repository, processor, notifier, config, logger, sleep = wait }) {
    this.repository = repository;
    this.processor = processor;
    this.notifier = notifier;
    this.config = config;
    this.logger = logger;
    this.sleep = sleep;
    this.stopping = false;
    this.workerHeartbeatTimer = null;
  }

  requestStop() {
    this.stopping = true;
  }

  async runDryPass() {
    const job = await this.repository.peekNextJob();
    if (!job) {
      this.logger.info('dry_run_no_job');
      return false;
    }

    try {
      const plan = await this.processor.preview(job);
      this.logger.info('dry_run_publish_plan', plan);
    } catch (error) {
      this.logger.error('dry_run_validation_failed', error, { jobId: job.id });
    }
    return true;
  }

  async runOne() {
    const job = await this.repository.leaseNextJob(
      this.config.workerId,
      this.config.leaseTimeoutMs,
    );
    if (!job) return false;

    const heartbeat = new LeaseHeartbeat({
      repository: this.repository,
      jobId: job.id,
      workerId: this.config.workerId,
      intervalMs: this.config.leaseHeartbeatMs,
      logger: this.logger,
    });
    heartbeat.start();
    this.logger.info('job_leased', {
      jobId: job.id,
      type: job.type,
      postId: job.postId,
      accountId: job.accountId,
      attempt: job.attempts,
    });

    try {
      const result = await this.processor.process(job, heartbeat);
      this.logger.info('job_succeeded', { jobId: job.id, type: job.type, result });
    } catch (error) {
      if (error instanceof LostLeaseError) {
        this.logger.warn('job_lease_lost', { jobId: job.id });
        return true;
      }

      if (error instanceof DeferredError) {
        await this.repository.deferJob(job, this.config.workerId, error.runAt, error.message);
        this.logger.info('job_deferred', {
          jobId: job.id,
          code: error.code,
          runAt: error.runAt.toISOString(),
        });
        return true;
      }

      const retryable = error?.retryable !== false;
      const exhausted = job.attempts >= job.maxAttempts;
      if (retryable && !exhausted) {
        const delayMs = calculateBackoffMs({
          attempt: job.attempts,
          retryAfterMs: error.retryAfterMs,
          baseMs: this.config.retryBaseMs,
          maxMs: this.config.retryMaxMs,
        });
        const nextRunAt = new Date(Date.now() + delayMs);
        await this.repository.retryJob(job, this.config.workerId, nextRunAt, toErrorMessage(error));
        this.logger.error('job_retry_scheduled', error, {
          jobId: job.id,
          attempt: job.attempts,
          nextRunAt: nextRunAt.toISOString(),
        });
        if (this.config.alertOnRetry) {
          await this.notifier.notifyFailure({
            job,
            post: job.post,
            account: job.post?.account || job.account,
            error,
            terminal: false,
            nextRunAt,
          });
        }
      } else {
        const reconciliationRequired = error?.reconciliationRequired === true;
        const terminalDead = exhausted || reconciliationRequired;
        const terminalResult = reconciliationRequired
          ? {
            phase: 'needs_reconciliation',
            detectedAt: new Date().toISOString(),
            code: error.code,
            details: error.details || null,
          }
          : null;
        await this.repository.failJob(
          job,
          this.config.workerId,
          toErrorMessage(error),
          terminalDead,
          terminalResult,
        );
        this.logger.error('job_failed', error, {
          jobId: job.id,
          attempt: job.attempts,
          terminalStatus: terminalDead ? 'dead' : 'failed',
          reconciliationRequired,
        });
        await this.notifier.notifyFailure({
          job,
          post: job.post,
          account: job.post?.account || job.account,
          error,
          terminal: true,
        });
      }
    } finally {
      heartbeat.stop();
    }
    return true;
  }

  async #heartbeatProcess() {
    try {
      await this.repository.heartbeatWorker(this.config.workerId, {
        dryRun: this.config.dryRun,
        pid: process.pid,
      });
    } catch (error) {
      this.logger.error('worker_heartbeat_failed', error);
    }
  }

  async run() {
    this.logger.info('worker_started', {
      workerId: this.config.workerId,
      dryRun: this.config.dryRun,
    });

    if (this.config.dryRun) {
      do {
        await this.runDryPass();
        if (this.config.dryRunOnce) break;
        await this.sleep(this.config.pollIntervalMs);
      } while (!this.stopping);
      return;
    }

    await this.#heartbeatProcess();
    this.workerHeartbeatTimer = setInterval(
      () => void this.#heartbeatProcess(),
      this.config.processHeartbeatMs,
    );
    this.workerHeartbeatTimer.unref?.();

    try {
      while (!this.stopping) {
        const handled = await this.runOne();
        if (!handled && !this.stopping) await this.sleep(this.config.pollIntervalMs);
      }
    } finally {
      if (this.workerHeartbeatTimer) clearInterval(this.workerHeartbeatTimer);
      this.logger.info('worker_stopped', { workerId: this.config.workerId });
    }
  }
}
