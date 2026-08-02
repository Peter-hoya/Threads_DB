function graphId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value.id === undefined ? null : String(value.id);
  return String(value);
}

function graphBoolean(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

export function validateReconciledThreadsMedia(media, {
  externalId,
  threadsUserId,
  target,
  parentPostId = null,
}) {
  if (!media || String(media.id || '') !== String(externalId)) {
    throw new Error('Meta 응답의 게시물 ID가 입력값과 일치하지 않습니다.');
  }
  if (graphId(media.owner) !== String(threadsUserId)) {
    throw new Error('입력한 게시물은 이 자동화 계정이 소유한 글이 아닙니다.');
  }

  const isReply = graphBoolean(media.is_reply);
  if (target === 'main' && isReply !== false) {
    throw new Error('Meta가 본문임을 명확히 확인한 게시물 ID만 사용할 수 있습니다.');
  }
  if (target === 'reply') {
    if (isReply !== true) throw new Error('입력한 게시물은 답글이 아닙니다.');
    if (!parentPostId || graphId(media.replied_to) !== String(parentPostId)) {
      throw new Error('입력한 답글은 이 게시물의 본문에 달린 답글이 아닙니다.');
    }
  }

  return {
    id: String(media.id),
    ownerId: graphId(media.owner),
    isReply: isReply === true,
    repliedToId: graphId(media.replied_to),
  };
}
