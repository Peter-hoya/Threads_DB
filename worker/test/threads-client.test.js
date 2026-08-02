import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadsClient } from '../src/threads-client.js';

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('classifies 429 and 5xx responses as retryable without exposing the token', async () => {
  const client = new ThreadsClient({
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer secret-token');
      return response(429, { error: { message: 'Rate limited', code: 4 } }, { 'retry-after': '9' });
    },
  });

  await assert.rejects(
    client.resolveUserId('secret-token'),
    (error) => error.retryable === true
      && error.retryAfterMs === 9_000
      && !error.message.includes('secret-token'),
  );
});

test('polls a container until FINISHED and calls the lease heartbeat', async () => {
  const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
  let heartbeats = 0;
  const client = new ThreadsClient({
    fetchImpl: async () => response(200, { status: statuses.shift() }),
    pollDelaysMs: [1, 1],
    sleep: async () => {},
  });

  const result = await client.waitForContainer('container-1', 'token', {
    heartbeat: async () => { heartbeats += 1; },
  });
  assert.equal(result.status, 'FINISHED');
  assert.equal(heartbeats, 3);
});

test('creates and publishes only through the official API paths', async () => {
  const calls = [];
  const client = new ThreadsClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { id: calls.length === 1 ? 'container-1' : 'post-1' });
    },
  });

  const containerId = await client.createContainer({
    endpointUserId: 'user-1',
    media_type: 'TEXT',
    text: 'hello',
    access_token: 'secret',
  });
  const postId = await client.publishContainer('user-1', containerId, 'secret');
  assert.equal(postId, 'post-1');
  assert.equal(calls[0].url, 'https://graph.threads.net/v1.0/user-1/threads');
  assert.equal(calls[1].url, 'https://graph.threads.net/v1.0/user-1/threads_publish');
  assert.doesNotMatch(calls[0].options.body, /secret/);
});
