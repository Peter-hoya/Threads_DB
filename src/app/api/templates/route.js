import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('accountId');
    const where = accountId ? { accountId: parseInt(accountId) } : {};
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
    const body = await request.json();
    const template = await prisma.template.create({
      data: {
        accountId: parseInt(body.accountId),
        templateCode: body.templateCode,
        templateName: body.templateName || null,
        promptText: body.promptText,
      },
    });
    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
