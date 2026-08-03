import { NextResponse } from 'next/server';

export async function POST(_request, { params }) {
  const { id } = await params;
  return NextResponse.json(
    {
      error: '브라우저에서 Meta API를 직접 호출하는 즉시 발행은 비활성화되었습니다.',
      action: `/api/posts/${id}/approve`,
      message: '게시물을 검토·승인하면 VPS 워커가 중복 없이 발행합니다.',
    },
    { status: 410 },
  );
}
