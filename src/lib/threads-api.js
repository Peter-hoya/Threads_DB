/**
 * Threads API 유틸리티
 * Meta Threads API를 사용하여 텍스트/미디어 게시물 및 스레드(답글)를 발행합니다.
 */

const API_BASE = 'https://graph.threads.net/v1.0';
const PUBLISH_WAIT_MS = 30000; // Meta 권장 대기 시간

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
      let errText = await createRes.text();
      let errJson;
      try { errJson = JSON.parse(errText); } catch(e) { errJson = errText || 'Empty response from Meta API'; }
      return { success: false, error: `컨테이너 생성 실패: ${typeof errJson === 'object' ? JSON.stringify(errJson) : errJson}` };
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
      let errText = await publishRes.text();
      let errJson;
      try { errJson = JSON.parse(errText); } catch(e) { errJson = errText || 'Empty response from Meta API'; }
      return { success: false, error: `발행 실패: ${typeof errJson === 'object' ? JSON.stringify(errJson) : errJson}` };
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

