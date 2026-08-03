# Threads official API publish worker

This process polls Neon directly and publishes only approved posts belonging to
owned `automation` accounts through Meta's official Threads Graph API. It never
logs in to Instagram/Threads, scrapes pages, or simulates a mobile device.

## Safety model

- The `primary` account is always rejected. `isActive`, `postingEnabled`, token
  status/expiry, per-account operating hours and the daily limit are checked
  again immediately before publishing.
- A post must have `approvalStatus=approved`, `approvedAt`, policy confirmations,
  an exact SHA-256 `payloadHash`, and the expected `idempotencyKey`. Editing any
  approved payload field causes the worker to fail closed.
- Affiliate disclosure is appended to the approved reply. If there is no reply,
  it is appended to the main post. The final 500-character limit is validated.
- Access tokens are AES-256-GCM ciphertext in `account_credentials`. The worker
  prefers `THREADS_TOKEN_ENCRYPTION_KEY` and supports
  `TOKEN_ENCRYPTION_KEY_V1` as a compatibility fallback. Tokens are never put in
  logs or URLs. Ciphertext is bound to `accountId` and encryption version using
  AES-GCM additional authenticated data, so moving it to another account fails.
- Jobs are leased with `FOR UPDATE SKIP LOCKED`. A PostgreSQL advisory lock plus
  a second active-lease check guarantees one running job per account. Both job
  and process heartbeats are persisted; a crashed job can be reclaimed after
  the lease timeout.
- The approved account-bound payload hash, account-neutral content fingerprint,
  and generation-specific idempotency key must match both the post and immutable
  `job.payload`. Every state transition repeats this generation check.
- Identical content is blocked while another copy is queued/publishing and for
  90 days after publication by default. `CONTENT_REUSE_COOLDOWN_DAYS` changes the
  published-content cooldown without weakening the active-job check.
- The container ID is committed before status polling and is reused on retry.
  Existing external post IDs short-circuit API calls. Replies are separate,
  deduplicated `publish_reply` jobs, so a reply failure never republishes the
  parent.
- Errors before `threads_publish` (container creation/status polling) can use
  Retry-After-aware exponential backoff. Once `threads_publish` starts, a durable
  attempt marker prevents automatic replay. Network/timeout, HTTP 429/5xx, or a
  returned external ID that cannot be persisted makes the job `dead`, sets
  `needsReconciliation`, and can trigger Telegram alerts.
- Other permanent failures stop immediately; exhausted jobs become `dead`.

There is an unavoidable distributed-systems ambiguity if Meta accepts a
`threads_publish` request but its post ID does not reach Neon. The worker chooses
duplicate prevention over unattended recovery: it never repeats such a request.
An operator must inspect Threads, record the real external ID or confirm that no
post exists, clear the reconciliation flag, and only then create a new job.

## Local verification

From the repository root:

```bash
node --test worker/test/*.test.js
npx prisma validate
```

The test suite uses Node's built-in test runner and never calls Meta or Neon.

For a read-only queue preview, configure the environment and run:

```bash
DRY_RUN=1 DRY_RUN_ONCE=1 node worker/src/main.js
```

Dry-run does not lease jobs, update posts, decrypt tokens, or call Threads. It
checks the next due job's approval, account, idempotency and final text plan.

## Queue lifecycle

1. The admin approves a post and creates one `publish_post` job with a unique
   dedupe key and immutable hash/fingerprint/idempotency payload.
2. The worker atomically leases it, validates the unchanged approved payload,
   resolves `/me` using the encrypted token, and creates/reuses a container.
3. It polls the official container status and then calls `threads_publish`.
4. The worker stores the external post ID and marks the job succeeded.
5. When approved reply text exists, the same transaction creates a unique
   `publish_reply` job. That job creates a TEXT reply container with
   `reply_to_id`, publishes it, and records its own IDs.

All timestamps remain UTC in PostgreSQL. Account `timezone` is used only for the
operating window and daily counter.

## Deployment

Copy/clone the complete repository to `/opt/threads-db`, then follow
[`ops/README.md`](../ops/README.md). No account access token belongs in the env
file: accounts are connected later through the admin OAuth/token setup, which
stores encrypted credentials in Neon.
