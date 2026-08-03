export async function revokeThreadsAccess(tx, threadsUserId, {
  deleteMetaData = false,
  confirmationCode = null,
} = {}) {
  const account = await tx.account.findUnique({
    where: { threadsUserId: String(threadsUserId) },
    select: { id: true },
  });
  if (!account) return { matched: false, accountId: null };

  await tx.accountCredential.deleteMany({ where: { accountId: account.id } });
  await tx.oAuthState.deleteMany({ where: { accountId: account.id } });
  await tx.job.updateMany({
    where: { accountId: account.id, status: { in: ['queued', 'failed'] } },
    data: {
      status: 'cancelled',
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: deleteMetaData
        ? 'Meta 사용자 데이터 삭제 요청으로 취소되었습니다.'
        : 'Meta 앱 권한이 해제되어 취소되었습니다.',
    },
  });

  const disconnectedFields = {
    postingEnabled: false,
    threadsAccessToken: null,
    tokenStatus: 'missing',
    tokenType: null,
    tokenScopes: null,
    tokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastValidatedAt: null,
    oauthConnectedAt: null,
  };

  if (!deleteMetaData) {
    await tx.account.update({
      where: { id: account.id },
      data: disconnectedFields,
    });
    await tx.auditEvent.create({
      data: {
        accountId: account.id,
        actorType: 'meta',
        action: 'account.meta_deauthorized',
        entityType: 'account',
        entityId: String(account.id),
      },
    });
    return { matched: true, accountId: account.id };
  }

  await tx.post.updateMany({
    where: { accountId: account.id },
    data: {
      containerId: null,
      containerCreatedAt: null,
      postIdExternal: null,
      replyContainerId: null,
      replyPostIdExternal: null,
      replyPublishedAt: null,
      needsReconciliation: false,
      reconciliationNote: null,
    },
  });
  await tx.job.updateMany({
    where: { accountId: account.id },
    data: { result: { redacted: true, reason: 'meta_data_deleted' } },
  });
  await tx.auditEvent.deleteMany({ where: { accountId: account.id } });
  await tx.account.update({
    where: { id: account.id },
    data: {
      ...disconnectedFields,
      threadsUserId: null,
      threadsUsername: null,
    },
  });
  await tx.auditEvent.create({
    data: {
      accountId: account.id,
      actorType: 'meta',
      action: 'account.meta_data_deleted',
      entityType: 'account',
      entityId: String(account.id),
      metadata: confirmationCode ? { confirmationCode } : null,
    },
  });
  return { matched: true, accountId: account.id };
}
