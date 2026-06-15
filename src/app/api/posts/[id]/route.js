import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const data = { ...body };
    if (data.scheduledAt) data.scheduledAt = new Date(data.scheduledAt);
    if (data.publishedAt) data.publishedAt = new Date(data.publishedAt);
    if (data.accountId) data.accountId = parseInt(data.accountId);
    if (data.templateId) data.templateId = parseInt(data.templateId);

    const post = await prisma.post.update({
      where: { id: parseInt(id) },
      data,
    });
    return NextResponse.json(post);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    await prisma.post.delete({ where: { id: parseInt(id) } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
