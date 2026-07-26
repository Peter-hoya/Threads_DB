import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

function maskToken(token) {
  if (!token) return null;
  if (token.length <= 6) return '******';
  return token.slice(0, 6) + '*'.repeat(Math.min(token.length - 6, 20));
}

function sanitizeAccount(account) {
  return {
    ...account,
    threadsAccessToken: maskToken(account.threadsAccessToken),
    _hasToken: !!account.threadsAccessToken,
  };
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    const data = { ...body };
    if ('threadsUserId' in data && !data.threadsUserId) data.threadsUserId = null;

    // 계정 수정 화면에서 토큰을 비워 보내면 기존 토큰을 유지합니다.
    // 토큰 제거가 필요할 때만 API에 null을 명시적으로 전달합니다.
    if ('threadsAccessToken' in data) {
      if (data.threadsAccessToken === '') {
        delete data.threadsAccessToken;
      } else if (typeof data.threadsAccessToken === 'string') {
        data.threadsAccessToken = data.threadsAccessToken.trim();
      }
    }

    const account = await prisma.account.update({
      where: { id: parseInt(id) },
      data,
    });
    return NextResponse.json(sanitizeAccount(account));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    await prisma.account.delete({ where: { id: parseInt(id) } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
