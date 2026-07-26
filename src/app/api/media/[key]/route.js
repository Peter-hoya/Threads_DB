import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';

export async function GET(request, { params }) {
  try {
    const { key } = await params;
    const store = getStore('media-store');

    const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });

    if (!blob || !blob.data) {
      return new NextResponse('미디어를 찾을 수 없습니다.', { status: 404 });
    }

    const mimeType = blob.metadata?.mimeType || 'application/octet-stream';

    return new NextResponse(blob.data, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });

  } catch (error) {
    console.error('Media Serving Error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
