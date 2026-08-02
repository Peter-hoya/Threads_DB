import { parseRetryAfter } from './backoff.js';
import { PermanentError, RetryableError } from './errors.js';

const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactMetaError(body, fallback, token) {
  const error = body?.error || body;
  const rawMessage = String(error?.message || fallback);
  return {
    message: token ? rawMessage.split(token).join('[REDACTED]') : rawMessage,
    type: error?.type,
    code: error?.code,
    subcode: error?.error_subcode,
    traceId: error?.fbtrace_id,
  };
}

export class ThreadsClient {
  constructor({
    fetchImpl = globalThis.fetch,
    baseUrl = 'https://graph.threads.net/v1.0',
    requestTimeoutMs = 30_000,
    pollDelaysMs = [1_000, 2_000, 3_000, 5_000, 8_000, 13_000],
    sleep = wait,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.pollDelaysMs = pollDelaysMs;
    this.sleep = sleep;
  }

  async request(path, { method = 'GET', token, form = null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetch(`${this.baseUrl}/${String(path).replace(/^\//, '')}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: controller.signal,
      });

      const raw = await response.text();
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }

      if (!response.ok) {
        const details = redactMetaError(body, raw || `Threads API returned HTTP ${response.status}`, token);
        const retryable = response.status === 429
          || response.status >= 500
          || TRANSIENT_META_CODES.has(Number(details.code));
        const ErrorClass = retryable ? RetryableError : PermanentError;
        throw new ErrorClass(`Threads API error: ${details.message}`, {
          code: `THREADS_HTTP_${response.status}`,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          details: { status: response.status, ...details },
        });
      }

      return body;
    } catch (error) {
      if (error instanceof RetryableError || error instanceof PermanentError) throw error;
      if (error?.name === 'AbortError') {
        throw new RetryableError('Threads API request timed out.', { code: 'THREADS_TIMEOUT' });
      }
      throw new RetryableError(`Threads API network error: ${error.message}`, {
        code: 'THREADS_NETWORK_ERROR',
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolveUserId(token) {
    const profile = await this.request('me?fields=id', { token });
    if (!profile?.id) {
      throw new PermanentError('Threads /me response did not include an account id.', {
        code: 'THREADS_ACCOUNT_ID_MISSING',
      });
    }
    return String(profile.id);
  }

  async createContainer(payload) {
    const { endpointUserId, access_token: token, ...form } = payload;
    const result = await this.request(`${encodeURIComponent(endpointUserId)}/threads`, {
      method: 'POST',
      token,
      form,
    });
    if (!result?.id) {
      throw new RetryableError('Threads container response did not include an id.', {
        code: 'THREADS_CONTAINER_ID_MISSING',
      });
    }
    return String(result.id);
  }

  async getContainerStatus(containerId, token) {
    const result = await this.request(`${encodeURIComponent(containerId)}?fields=id,status,error_message`, { token });
    return {
      status: String(result?.status || result?.status_code || 'IN_PROGRESS').toUpperCase(),
      errorMessage: result?.error_message || null,
    };
  }

  async waitForContainer(containerId, token, { heartbeat = async () => {} } = {}) {
    for (let index = 0; index <= this.pollDelaysMs.length; index += 1) {
      await heartbeat();
      const result = await this.getContainerStatus(containerId, token);

      if (result.status === 'FINISHED' || result.status === 'PUBLISHED') return result;
      if (result.status === 'ERROR' || result.status === 'EXPIRED') {
        throw new PermanentError(
          `Threads container ${result.status.toLowerCase()}: ${result.errorMessage || 'no detail provided'}`,
          { code: `THREADS_CONTAINER_${result.status}` },
        );
      }

      if (index < this.pollDelaysMs.length) {
        await this.sleep(this.pollDelaysMs[index]);
      }
    }

    throw new RetryableError('Threads container is still processing.', {
      code: 'THREADS_CONTAINER_NOT_READY',
    });
  }

  async publishContainer(userId, containerId, token) {
    const result = await this.request(`${encodeURIComponent(userId)}/threads_publish`, {
      method: 'POST',
      token,
      form: { creation_id: containerId },
    });
    if (!result?.id) {
      throw new RetryableError('Threads publish response did not include a post id.', {
        code: 'THREADS_POST_ID_MISSING',
      });
    }
    return String(result.id);
  }
}
