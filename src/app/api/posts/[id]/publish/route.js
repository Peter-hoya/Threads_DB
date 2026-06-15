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

    if (!userId || !accessToken) {
      return NextResponse.json(
        { error: `계정 "${post.account.accountName}"에 Threads API 인증 정보가 설정되지 않았습니다. 계정 관리에서 User ID와 Access Token을 입력하세요.` },
        { status: 500 }
      );
    }

    const result = await publishToThreads(post.content, userId, accessToken);

    if (result.success) {
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
