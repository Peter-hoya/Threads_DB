import assert from 'node:assert/strict';
import test from 'node:test';
import { revokeThreadsAccess } from './meta-account-removal.js';

function transactionFixture({ account = { id: 7 } } = {}) {
  const calls = [];
  return {
    calls,
    tx: {
      account: {
        findUnique: async (args) => { calls.push(['account.findUnique', args]); return account; },
        update: async (args) => { calls.push(['account.update', args]); },
      },
      accountCredential: {
        deleteMany: async (args) => { calls.push(['credential.deleteMany', args]); },
      },
      oAuthState: {
        deleteMany: async (args) => { calls.push(['oauth.deleteMany', args]); },
      },
      job: {
        updateMany: async (args) => { calls.push(['job.updateMany', args]); },
      },
      post: {
        updateMany: async (args) => { calls.push(['post.updateMany', args]); },
      },
      auditEvent: {
        create: async (args) => { calls.push(['audit.create', args]); },
        deleteMany: async (args) => { calls.push(['audit.deleteMany', args]); },
      },
    },
  };
}

test('권한 해제는 토큰을 지우고 자동 발행을 중지한다', async () => {
  const { tx, calls } = transactionFixture();
  const result = await revokeThreadsAccess(tx, 'threads-user-7');
  assert.deepEqual(result, { matched: true, accountId: 7 });
  const update = calls.find(([name]) => name === 'account.update')[1];
  assert.equal(update.data.postingEnabled, false);
  assert.equal(update.data.tokenStatus, 'missing');
  assert.equal(update.data.threadsUserId, undefined);
  assert.ok(calls.some(([name]) => name === 'credential.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'audit.create'));
});

test('데이터 삭제는 Meta 식별정보와 외부 게시물 ID를 제거한다', async () => {
  const { tx, calls } = transactionFixture();
  await revokeThreadsAccess(tx, 'threads-user-7', {
    deleteMetaData: true,
    confirmationCode: 'confirmation-7',
  });
  const accountUpdate = calls.find(([name]) => name === 'account.update')[1];
  const postUpdate = calls.find(([name]) => name === 'post.updateMany')[1];
  const auditCreate = calls.find(([name]) => name === 'audit.create')[1];
  assert.equal(accountUpdate.data.threadsUserId, null);
  assert.equal(accountUpdate.data.threadsUsername, null);
  assert.equal(postUpdate.data.postIdExternal, null);
  assert.equal(postUpdate.data.replyPostIdExternal, null);
  assert.deepEqual(auditCreate.data.metadata, { confirmationCode: 'confirmation-7' });
  assert.ok(calls.some(([name]) => name === 'audit.deleteMany'));
});

test('이미 삭제된 Meta 사용자의 반복 요청도 성공적으로 처리한다', async () => {
  const { tx, calls } = transactionFixture({ account: null });
  const result = await revokeThreadsAccess(tx, 'missing-user', { deleteMetaData: true });
  assert.deepEqual(result, { matched: false, accountId: null });
  assert.equal(calls.length, 1);
});
