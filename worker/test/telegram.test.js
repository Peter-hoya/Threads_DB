import assert from 'node:assert/strict';
import test from 'node:test';
import { ReconciliationRequiredError } from '../src/errors.js';
import { TelegramNotifier } from '../src/telegram.js';

test('reconciliation alert includes known external and container IDs', async () => {
  let requestBody;
  const notifier = new TelegramNotifier({
    botToken: 'bot-secret',
    chatId: 'chat-1',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response('{}', { status: 200 });
    },
    logger: { error() {} },
  });
  const error = new ReconciliationRequiredError('DB persistence uncertain', {
    details: { knownExternalId: 'post-123', containerId: 'container-456' },
  });

  await notifier.notifyFailure({
    job: { id: 1, type: 'publish_post', postId: 2 },
    post: { id: 2 },
    account: { accountName: '자동계정' },
    error,
    terminal: true,
  });
  assert.match(requestBody.text, /post-123/);
  assert.match(requestBody.text, /container-456/);
  assert.doesNotMatch(requestBody.text, /bot-secret/);
});
