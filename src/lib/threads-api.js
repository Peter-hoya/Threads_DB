/**
 * Threads API 유틸리티
 * Meta Threads API를 사용하여 텍스트/미디어 게시물 및 스레드(답글)를 발행합니다.
 */

const API_BASE = 'https://graph.threads.net/v1.0';
const PUBLISH_WAIT_MS = 30000; // Meta 권장 대기 시간

async function getMetaError(response, fallback) {
  const errText = await response.text();

  try {
    const errJson = JSON.parse(errText);
    return errJson?.error?.message || errJson?.message || fallback;
  } catch {
    return errText || fallback;
  }
}

/**
 * 저장된 User ID를 신뢰하지 않고 액세스 토큰의 실제 Threads 계정 ID를 조회합니다.
 * OAuth 과정에서 code/app id 등을 User ID로 잘못 저장해도 올바른 계정으로 발행됩니다.
 */
async function resolveThreadsUserId(accessToken) {
  const params = new URLSearchParams({
    fields: 'id',
    access_token: accessToken,
  });
  const response = await fetch(`${API_BASE}/me?${params.toString()}`);

  if (!response.ok) {
    const error = await getMetaError(response, 'Threads 계정 정보를 확인할 수 없습니다.');
    return { success: false, error: `Threads 계정 확인 실패: ${error}` };
  }

  const profile = await response.json();
  if (!profile.id) {
    return { success: false, error: 'Threads 계정 확인 실패: 사용자 ID가 응답에 없습니다.' };
  }

  return { success: true, userId: String(profile.id) };
}

/**
 * 단일 게시물을 Threads에 발행하는 헬퍼 함수
 */
async function publishSinglePost(text, userId, accessToken, mediaUrl = null, mediaType = null, replyToId = null) {
  try {
    const payload = {
      text,
      access_token: accessToken,
    };

    if (mediaUrl && mediaType === 'image') {
      payload.media_type = 'IMAGE';
      payload.image_url = mediaUrl;
    } else if (mediaUrl && mediaType === 'video') {
      payload.media_type = 'VIDEO';
      payload.video_url = mediaUrl;
    } else {
      payload.media_type = 'TEXT';
    }

    if (replyToId) {
      payload.reply_to_id = replyToId;
    }

    // 1단계: 미디어 컨테이너 생성
    const createRes = await fetch(`${API_BASE}/${userId}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!createRes.ok) {
      const error = await getMetaError(createRes, 'Meta API 응답이 비어 있습니다.');
      return { success: false, error: `컨테이너 생성 실패: ${error}` };
    }

    const { id: creationId } = await createRes.json();

    // 2단계: 처리 대기 (Meta 권장 30초)
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_WAIT_MS));

    // 3단계: 게시물 발행
    const publishRes = await fetch(`${API_BASE}/${userId}/threads_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: creationId,
        access_token: accessToken,
      }),
    });

    if (!publishRes.ok) {
      const error = await getMetaError(publishRes, 'Meta API 응답이 비어 있습니다.');
      return { success: false, error: `발행 실패: ${error}` };
    }

    const { id: postId } = await publishRes.json();
    return { success: true, postId: String(postId) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Threads에 게시물(본문+답글) 발행
 * @param {Object} post - DB Post 객체
 * @param {string} userId - Threads 사용자 ID
 * @param {string} accessToken - Threads 액세스 토큰
 * @returns {{ success: boolean, postId?: string, error?: string }}
 */
export async function publishToThreads(post, userId, accessToken) {
  const resolvedUser = await resolveThreadsUserId(accessToken);
  if (!resolvedUser.success) {
    return resolvedUser;
  }

  // userId는 기존 호출부 호환을 위해 인자로 유지하되, 실제 발행에는 토큰 소유자의 ID를 사용합니다.
  userId = resolvedUser.userId;

  // 본문 발행
  const mainResult = await publishSinglePost(post.content, userId, accessToken, post.mediaUrl, post.mediaType);
  
  if (!mainResult.success) {
    return mainResult;
  }

  // 본문 발행 성공 후, 답글(replyContent)이 있다면 이어서 발행
  if (post.replyContent && post.replyContent.trim() !== '') {
    const replyResult = await publishSinglePost(post.replyContent, userId, accessToken, null, null, mainResult.postId);
    if (!replyResult.success) {
      // 본문은 성공했으나 답글이 실패한 경우 (반쪽짜리 성공이지만 본문 postId는 반환)
      return { success: true, postId: mainResult.postId, error: `본문은 발행되었으나 답글 발행 실패: ${replyResult.error}` };
    }
  }

  return { success: true, postId: mainResult.postId };
}
