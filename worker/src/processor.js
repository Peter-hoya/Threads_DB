import { assertAccountCanPublish, nextDayOperatingTime } from './account-policy.js';
import { decryptAccessToken } from './crypto.js';
import {
  DeferredError,
  PermanentError,
  ReconciliationRequiredError,
} from './errors.js';
import {
  assertApprovedPayload,
  buildContainerPayload,
  buildPublishText,
} from './payload.js';

function assertManagedMedia(post, env) {
  if (!post.mediaUrl) return;
  if (!env.SUPABASE_URL) {
    throw new PermanentError('SUPABASE_URL is required for approved media.', {
      code: 'SUPABASE_URL_MISSING',
    });
  }
  let mediaUrl;
  let supabaseUrl;
  try {
    mediaUrl = new URL(post.mediaUrl);
    supabaseUrl = new URL(env.SUPABASE_URL);
  } catch {
    throw new PermanentError('Approved media or SUPABASE_URL is invalid.', {
      code: 'MEDIA_ORIGIN_INVALID',
    });
  }
  const prefix = '/storage/v1/object/public/threads-publish/media/';
  if (
    mediaUrl.origin !== supabaseUrl.origin
    || !mediaUrl.pathname.startsWith(prefix)
    || mediaUrl.pathname.length <= prefix.length
    || mediaUrl.search
    || mediaUrl.hash
  ) {
    throw new PermanentError('Approved media is not a managed threads-publish object.', {
      code: 'MEDIA_ORIGIN_NOT_MANAGED',
    });
  }
}

function assertPostPolicy(post, job, env = process.env) {
  if (!post) throw new PermanentError('Publish job has no post.', { code: 'JOB_POST_MISSING' });
  if (post.platform !== 'threads') {
    throw new PermanentError('Worker only supports the official Threads API.', {
      code: 'UNSUPPORTED_PLATFORM',
    });
  }
  if (job.accountId && Number(job.accountId) !== Number(post.accountId)) {
    throw new PermanentError('Job account does not match post account.', {
      code: 'JOB_ACCOUNT_MISMATCH',
    });
  }
  if (!post.rightsConfirmed || !post.policyReviewConfirmed) {
    throw new PermanentError('Post policy confirmations are incomplete.', {
      code: 'POST_POLICY_NOT_CONFIRMED',
    });
  }
  if (!String(post.affiliateDisclosure || '').trim()) {
    throw new PermanentError('Automatic posts require an affiliate disclosure.', {
      code: 'AFFILIATE_DISCLOSURE_REQUIRED',
    });
  }
  assertManagedMedia(post, env);

  assertApprovedPayload(post);
  const jobPayload = job.payload;
  if (!jobPayload || typeof jobPayload !== 'object' || Array.isArray(jobPayload)) {
    throw new PermanentError('Publish job has no immutable approval payload.', {
      code: 'JOB_PAYLOAD_MISSING',
    });
  }
  for (const field of ['payloadHash', 'contentFingerprint', 'idempotencyKey']) {
    if (!jobPayload[field] || jobPayload[field] !== post[field]) {
      throw new PermanentError(`Job ${field} does not match the post approval generation.`, {
        code: 'JOB_PAYLOAD_MISMATCH',
        details: { field },
      });
    }
  }
  const expectedPrefix = `threads:${post.id}:${post.payloadHash}:`;
  const idempotencyKey = String(post.idempotencyKey || '');
  const keySuffix = idempotencyKey.startsWith(expectedPrefix)
    ? idempotencyKey.slice(expectedPrefix.length)
    : '';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(keySuffix)) {
    throw new PermanentError('Post idempotency key is missing or does not match its approved payload.', {
      code: 'IDEMPOTENCY_KEY_INVALID',
    });
  }

  // This also validates the final disclosure-appended length before any API call.
  const publishText = buildPublishText(post);
  buildContainerPayload(post, 'validation', 'validation');
  if (publishText.replyContent) {
    buildContainerPayload(post, 'validation', 'validation', {
      reply: true,
      replyToId: 'validation',
    });
  }
  return publishText;
}

function isAmbiguousPublishFailure(error) {
  if (['THREADS_NETWORK_ERROR', 'THREADS_TIMEOUT', 'THREADS_POST_ID_MISSING'].includes(error?.code)) {
    return true;
  }
  const status = Number(error?.details?.status);
  return status === 429 || status >= 500;
}

export class PublishProcessor {
  constructor({
    repository,
    threadsClient,
    workerId,
    contentReuseCooldownDays = 90,
    env = process.env,
    logger,
    now = () => new Date(),
  }) {
    this.repository = repository;
    this.threadsClient = threadsClient;
    this.workerId = workerId;
    this.contentReuseCooldownDays = contentReuseCooldownDays;
    this.env = env;
    this.logger = logger;
    this.now = now;
  }

  async preview(job) {
    const post = job?.post;
    const account = post?.account || job?.account;
    const publishText = assertPostPolicy(post, job, this.env);
    assertAccountCanPublish(account, this.now(), {
      ignoreWindow: Boolean(post?.postIdExternal || post?.replyPostIdExternal),
    });
    if (job.type === 'publish_post' && !post.postIdExternal) {
      const duplicate = await this.repository.findDuplicateContent(
        post.id,
        post.contentFingerprint,
        this.contentReuseCooldownDays,
      );
      if (duplicate) {
        throw new PermanentError(`Duplicate content exists as post #${duplicate.id}.`, {
          code: 'DUPLICATE_CONTENT_BLOCKED',
        });
      }
      const publishedToday = await this.repository.getPublishedTodayCount(
        account.id,
        account.timezone || 'Asia/Seoul',
      );
      if (publishedToday >= account.dailyPostLimit) {
        throw new DeferredError(
          `Daily post limit (${account.dailyPostLimit}) reached.`,
          nextDayOperatingTime(account, this.now()),
          { code: 'DAILY_POST_LIMIT_REACHED' },
        );
      }
    }

    return {
      jobId: job.id,
      type: job.type,
      postId: post.id,
      accountId: account.id,
      accountName: account.accountName,
      resumesContainer: job.type === 'publish_reply'
        ? Boolean(post.replyContainerId)
        : Boolean(post.containerId),
      alreadyPublished: job.type === 'publish_reply'
        ? Boolean(post.replyPostIdExternal)
        : Boolean(post.postIdExternal),
      mediaType: post.mediaUrl ? String(post.mediaType).toUpperCase() : 'TEXT',
      hasReply: Boolean(publishText.replyContent),
    };
  }

  async process(job, heartbeat) {
    if (!['publish_post', 'publish_reply'].includes(job.type)) {
      throw new PermanentError(`Unsupported job type: ${job.type}`, { code: 'UNSUPPORTED_JOB_TYPE' });
    }

    const post = job.post;
    const account = post?.account || job.account;
    const publishText = assertPostPolicy(post, job, this.env);
    const unresolvedPublishAttempt = job.result?.phase === 'threads_publish_started';

    if (job.type === 'publish_post' && post.postIdExternal) {
      await this.repository.completeMain(
        job,
        this.workerId,
        post.postIdExternal,
        Boolean(publishText.replyContent),
        job.payload,
      );
      return { postIdExternal: post.postIdExternal, deduplicated: true };
    }
    if (job.type === 'publish_reply' && post.replyPostIdExternal) {
      await this.repository.completeReply(
        job,
        this.workerId,
        post.replyPostIdExternal,
        job.payload,
      );
      return { replyPostIdExternal: post.replyPostIdExternal, deduplicated: true };
    }

    if (unresolvedPublishAttempt) {
      throw new ReconciliationRequiredError(
        'A prior threads_publish request started without a durably stored external post ID. Reconcile the Threads account before retrying.',
        {
          details: {
            jobId: job.id,
            containerId: job.result.containerId || null,
            startedAt: job.result.startedAt || null,
          },
        },
      );
    }

    assertAccountCanPublish(account, this.now());

    if (job.type === 'publish_post') {
      const duplicate = await this.repository.findDuplicateContent(
        post.id,
        post.contentFingerprint,
        this.contentReuseCooldownDays,
      );
      if (duplicate) {
        throw new PermanentError(
          `Duplicate approved content is already ${duplicate.status} as post #${duplicate.id}.`,
          {
            code: 'DUPLICATE_CONTENT_BLOCKED',
            details: { duplicatePostId: duplicate.id, duplicateStatus: duplicate.status },
          },
        );
      }
      const publishedToday = await this.repository.getPublishedTodayCount(
        account.id,
        account.timezone || 'Asia/Seoul',
      );
      if (publishedToday >= account.dailyPostLimit) {
        throw new DeferredError(
          `Daily post limit (${account.dailyPostLimit}) reached.`,
          nextDayOperatingTime(account, this.now()),
          { code: 'DAILY_POST_LIMIT_REACHED' },
        );
      }
      await this.repository.beginMainPublish(job.id, this.workerId, post.id, job.payload);
    } else if (!post.postIdExternal) {
      throw new PermanentError('Cannot publish reply before its parent post.', {
        code: 'REPLY_PARENT_NOT_PUBLISHED',
      });
    } else if (!publishText.replyContent) {
      throw new PermanentError('Reply job has no approved reply content.', {
        code: 'REPLY_CONTENT_MISSING',
      });
    }

    const token = decryptAccessToken(account.credential, account.id, this.env);
    const userId = await this.threadsClient.resolveUserId(token);
    if (account.threadsUserId && String(account.threadsUserId) !== userId) {
      throw new PermanentError('Encrypted token belongs to a different Threads account.', {
        code: 'THREADS_ACCOUNT_TOKEN_MISMATCH',
      });
    }

    return job.type === 'publish_reply'
      ? this.#publishReply(job, post, userId, token, heartbeat)
      : this.#publishMain(job, post, userId, token, heartbeat, publishText);
  }

  async #publishMain(job, post, userId, token, heartbeat, publishText) {
    let containerId = post.containerId;
    if (!containerId) {
      containerId = await this.threadsClient.createContainer(
        buildContainerPayload(post, userId, token),
      );
      await this.repository.saveContainer(
        job.id,
        this.workerId,
        post.id,
        'containerId',
        containerId,
        job.payload,
      );
    }

    await this.threadsClient.waitForContainer(containerId, token, {
      heartbeat: () => heartbeat.assertOwned(),
    });
    const postIdExternal = await this.#publishContainerOnce(
      job,
      post,
      userId,
      containerId,
      token,
      heartbeat,
    );
    try {
      await heartbeat.assertOwned();
      await this.repository.completeMain(
        job,
        this.workerId,
        postIdExternal,
        Boolean(publishText.replyContent),
        job.payload,
      );
    } catch (error) {
      throw new ReconciliationRequiredError(
        'Threads returned a post ID, but its database persistence was not confirmed. Reconcile before retrying.',
        {
          cause: error,
          details: {
            knownExternalId: postIdExternal,
            containerId,
            phase: 'main',
            persistenceErrorCode: error?.code || error?.name || 'UNKNOWN',
          },
        },
      );
    }
    return { postIdExternal, containerId };
  }

  async #publishReply(job, post, userId, token, heartbeat) {
    let containerId = post.replyContainerId;
    if (!containerId) {
      containerId = await this.threadsClient.createContainer(
        buildContainerPayload(post, userId, token, {
          reply: true,
          replyToId: post.postIdExternal,
        }),
      );
      await this.repository.saveContainer(
        job.id,
        this.workerId,
        post.id,
        'replyContainerId',
        containerId,
        job.payload,
      );
    }

    await this.threadsClient.waitForContainer(containerId, token, {
      heartbeat: () => heartbeat.assertOwned(),
    });
    const replyPostIdExternal = await this.#publishContainerOnce(
      job,
      post,
      userId,
      containerId,
      token,
      heartbeat,
    );
    try {
      await heartbeat.assertOwned();
      await this.repository.completeReply(
        job,
        this.workerId,
        replyPostIdExternal,
        job.payload,
      );
    } catch (error) {
      throw new ReconciliationRequiredError(
        'Threads returned a reply ID, but its database persistence was not confirmed. Reconcile before retrying.',
        {
          cause: error,
          details: {
            knownExternalId: replyPostIdExternal,
            containerId,
            phase: 'reply',
            persistenceErrorCode: error?.code || error?.name || 'UNKNOWN',
          },
        },
      );
    }
    return { replyPostIdExternal, containerId };
  }

  async #publishContainerOnce(job, post, userId, containerId, token, heartbeat) {
    await heartbeat.assertOwned();
    await this.repository.markPublishStarted(
      job.id,
      this.workerId,
      post.id,
      containerId,
      job.payload,
    );

    try {
      return await this.threadsClient.publishContainer(userId, containerId, token);
    } catch (error) {
      if (isAmbiguousPublishFailure(error)) {
        throw new ReconciliationRequiredError(
          'The threads_publish request has an ambiguous outcome. Reconcile the Threads account before retrying.',
          {
            cause: error,
            details: {
              containerId,
              phase: job.type === 'publish_reply' ? 'reply' : 'main',
              originalErrorCode: error?.code || error?.name || 'UNKNOWN',
            },
          },
        );
      }

      try {
        await this.repository.clearPublishStarted(
          job.id,
          this.workerId,
          post.id,
          containerId,
          job.payload,
        );
      } catch (clearError) {
        throw new ReconciliationRequiredError(
          'Threads rejected the publish request, but the durable attempt marker could not be cleared.',
          {
            cause: clearError,
            details: { containerId, originalErrorCode: error?.code || null },
          },
        );
      }
      throw error;
    }
  }
}
