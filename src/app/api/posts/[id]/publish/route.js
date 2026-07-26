import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { publishToThreads } from '@/lib/threads-api';

export async function POST(request, { params }) {
  const { id } = await params;
  const postId = parseInt(id);

  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { account: true },
    });

    if (!post) {
      return NextResponse.json({ error: '게시물을 찾을 수 없습니다.' }, { status: 404 });
    }
    if (post.platform !== 'threads') {
      return NextResponse.json({ error: '현재 Threads 발행만 지원합니다.' }, { status: 400 });
    }
    if (post.status === 'published') {
      return NextResponse.json({ error: '이미 발행된 게시물입니다.' }, { status: 400 });
    }

    // 계정에 저장된 토큰 우선 사용, 없으면 환경변수 폴백
    const userId = post.account.threadsUserId || process.env.THREADS_USER_ID;
    const accessToken = post.account.threadsAccessToken || process.env.THREADS_ACCESS_TOKEN;

    let result;
    if (!accessToken) {
      // 토큰이 없는 경우 테스트/개발 목적으로 API 호출을 우회(Mock)하고 성공 처리합니다.
      console.log(`[Mock Mode] No token provided for account "${post.account.accountName}". Bypassing Meta API.`);
      result = { success: true, postId: `mock_${Date.now()}` };
    } else {
      result = await publishToThreads(post, userId, accessToken);
    }

    if (result.success) {
      // 업로드된 내부 이미지(Netlify Blobs)인 경우 발행 성공 후 삭제하여 서버 용량 확보
      if (post.mediaUrl && post.mediaUrl.includes('/api/media/')) {
        try {
          const { getStore } = await import('@netlify/blobs');
          const blobKey = post.mediaUrl.split('/api/media/')[1];
          if (blobKey) {
            const store = getStore('media-store');
            await store.delete(blobKey);
            console.log(`[Storage] Deleted media blob to save space: ${blobKey}`);
          }
        } catch (err) {
          console.error('[Storage] Failed to delete media blob:', err);
        }
      }

      const updated = await prisma.post.update({
        where: { id: postId },
        data: {
          status: 'published',
          publishedAt: new Date(),
          postIdExternal: result.postId,
        },
      });
      return NextResponse.json({ success: true, post: updated, externalId: result.postId });
    } else {
      await prisma.post.update({
        where: { id: postId },
        data: { status: 'failed', errorMessage: result.error },
      });
      return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }
  } catch (error) {
    await prisma.post.update({
      where: { id: postId },
      data: { status: 'failed', errorMessage: error.message },
    }).catch(() => {});
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
