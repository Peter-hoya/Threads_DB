import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

function parseTemplateInput(body, { partial = false } = {}) {
  const allowed = new Set(['accountId', 'templateCode', 'templateName', 'promptText', 'isActive']);
  const unknown = Object.keys(body || {}).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`허용되지 않은 필드: ${unknown.join(', ')}`);

  const data = {};
  if (!partial || Object.hasOwn(body, 'accountId')) {
    const accountId = Number(body.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('계정을 선택해주세요.');
    data.accountId = accountId;
  }
  if (!partial || Object.hasOwn(body, 'templateCode')) {
    const code = String(body.templateCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,20}$/.test(code)) throw new Error('템플릿 코드는 영문·숫자·_- 20자 이내여야 합니다.');
    data.templateCode = code;
  }
  if (Object.hasOwn(body, 'templateName')) {
    const name = String(body.templateName || '').trim();
    if (name.length > 100) throw new Error('템플릿 이름이 너무 깁니다.');
    data.templateName = name || null;
  }
  if (!partial || Object.hasOwn(body, 'promptText')) {
    const prompt = String(body.promptText || '').trim();
    if (!prompt || prompt.length > 10_000) throw new Error('프롬프트는 1~10,000자로 입력해주세요.');
    data.promptText = prompt;
  }
  if (Object.hasOwn(body, 'isActive')) {
    if (typeof body.isActive !== 'boolean') throw new Error('활성 상태 값이 올바르지 않습니다.');
    data.isActive = body.isActive;
  }
  return data;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('accountId');
    const parsedAccountId = accountId ? Number(accountId) : null;
    if (accountId && (!Number.isSafeInteger(parsedAccountId) || parsedAccountId <= 0)) {
      return NextResponse.json({ error: '계정 ID가 올바르지 않습니다.' }, { status: 400 });
    }
    const where = parsedAccountId ? { accountId: parsedAccountId } : {};
    const templates = await prisma.template.findMany({
      where,
      include: { account: { select: { accountName: true } } },
      orderBy: [{ accountId: 'asc' }, { templateCode: 'asc' }],
    });
    return NextResponse.json(templates);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const template = await prisma.template.create({
      data: parseTemplateInput(await request.json()),
    });
    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    const status = error.code === 'P2002' ? 409 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
}

export { parseTemplateInput };
