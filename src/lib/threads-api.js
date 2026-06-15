/**
 * Threads API 유틸리티
 * Meta Threads API를 사용하여 텍스트 게시물을 발행합니다.
 */

const API_BASE = 'https://graph.threads.net/v1.0';
const PUBLISH_WAIT_MS = 30000; // Meta 권장 대기 시간

/**
 * Threads에 텍스트 게시물 발행
 * @param {string} text - 발행할 텍스트
 * @param {string} userId - Threads 사용자 ID
 * @param {string} accessToken - Threads 액세스 토큰
 * @returns {{ success: boolean, postId?: string, error?: string }}
 */
export async function publishToThreads(text, userId, accessToken) {
  try {
    // 1단계: 미디어 컨테이너 생성
    const createRes = await fetch(`${API_BASE}/${userId}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'TEXT',
        text,
        access_token: accessToken,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json();
      return { success: false, error: `컨테이너 생성 실패: ${JSON.stringify(err)}` };
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
      const err = await publishRes.json();
      return { success: false, error: `발행 실패: ${JSON.stringify(err)}` };
    }

    const { id: postId } = await publishRes.json();
    return { success: true, postId: String(postId) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
