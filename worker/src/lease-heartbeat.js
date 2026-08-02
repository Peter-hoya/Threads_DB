import { LostLeaseError } from './errors.js';

export class LeaseHeartbeat {
  constructor({ repository, jobId, workerId, intervalMs, logger }) {
    this.repository = repository;
    this.jobId = jobId;
    this.workerId = workerId;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.lost = false;
  }

  start() {
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
    this.timer.unref?.();
  }

  async beat() {
    if (this.running || this.lost) return;
    this.running = true;
    try {
      const owned = await this.repository.heartbeatJob(this.jobId, this.workerId);
      if (!owned) this.lost = true;
    } catch (error) {
      // A temporary heartbeat DB failure does not prove ownership was lost. The
      // final guarded update still prevents a stale worker from committing.
      this.logger?.error('job_heartbeat_failed', error, { jobId: this.jobId });
    } finally {
      this.running = false;
    }
  }

  async assertOwned() {
    if (this.lost) throw new LostLeaseError();
    const owned = await this.repository.heartbeatJob(this.jobId, this.workerId);
    if (!owned) {
      this.lost = true;
      throw new LostLeaseError();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
