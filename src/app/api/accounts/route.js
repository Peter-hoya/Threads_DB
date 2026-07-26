import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

/** 토큰 마스킹 - 앞 6자리만 표시하고 나머지는 *로 처리 */
function maskToken(token) {
  if (!token) return null;
  if (token.length <= 6) return '******';
  return token.slice(0, 6) + '*'.repeat(Math.min(token.length - 6, 20));
}

/** 응답 시 민감한 토큰 값을 마스킹 처리 */
function sanitizeAccount(account) {
  return {
    ...account,
    threadsAccessToken: maskToken(account.threadsAccessToken),
    _hasToken: !!account.threadsAccessToken,
  };
}

export async function GET() {
  try {
    const accounts = await prisma.account.findMany({
      include: { _count: { select: { posts: true, templates: true } } },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(accounts.map(sanitizeAccount));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const account = await prisma.account.create({
      data: {
        accountName: body.accountName,
        description: body.description || null,
        threadsUserId: body.threadsUserId || null,
        threadsAccessToken: body.threadsAccessToken || null,
      },
    });
    return NextResponse.json(sanitizeAccount(account), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
