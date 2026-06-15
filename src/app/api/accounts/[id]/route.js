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
    _hasToken: !!account.threadsAccessToken && !!account.threadsUserId,
  };
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    // 빈 문자열로 온 토큰 필드는 null로 치환
    const data = { ...body };
    if ('threadsUserId' in data && !data.threadsUserId) data.threadsUserId = null;
    if ('threadsAccessToken' in data && !data.threadsAccessToken) data.threadsAccessToken = null;

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
