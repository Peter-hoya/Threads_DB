import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { parseTemplateInput } from '../route';

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function PATCH(request, { params }) {
  try {
    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: '템플릿 ID가 올바르지 않습니다.' }, { status: 400 });
    const data = parseTemplateInput(await request.json(), { partial: true });
    const template = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "templates" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) {
        const error = new Error('템플릿을 찾을 수 없습니다.');
        error.status = 404;
        throw error;
      }
      const existing = await tx.template.findUniqueOrThrow({
        where: { id },
        select: { accountId: true, _count: { select: { posts: true } } },
      });
      if (data.accountId && data.accountId !== existing.accountId && existing._count.posts > 0) {
        const error = new Error('게시물에 사용된 템플릿은 다른 계정으로 이동할 수 없습니다.');
        error.status = 409;
        throw error;
      }
      if (data.accountId && data.accountId !== existing.accountId) {
        const account = await tx.account.findUnique({ where: { id: data.accountId }, select: { id: true } });
        if (!account) {
          const error = new Error('이동할 계정을 찾을 수 없습니다.');
          error.status = 404;
          throw error;
        }
      }
      return tx.template.update({ where: { id }, data });
    });
    return NextResponse.json(template);
  } catch (error) {
    const status = error.status || (error.code === 'P2025' ? 404 : error.code === 'P2002' ? 409 : 400);
    return NextResponse.json({ error: error.message }, { status });
  }
}

export async function DELETE(_request, { params }) {
  try {
    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: '템플릿 ID가 올바르지 않습니다.' }, { status: 400 });
    await prisma.template.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = error.code === 'P2025' ? 404 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
}
