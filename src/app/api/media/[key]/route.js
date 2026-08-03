import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';

export const dynamic = 'force-dynamic';

function isLegacyBlobKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9._-]{1,255}$/.test(key);
}

async function readLegacyBlob(params) {
  const { key } = await params;
  if (!isLegacyBlobKey(key)) return { error: '미디어 키가 올바르지 않습니다.', status: 400 };

  const store = getStore('media-store');
  const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!blob || !blob.data) return { error: '미디어를 찾을 수 없습니다.', status: 404 };

  return {
    data: blob.data,
    mimeType: blob.metadata?.mimeType || 'application/octet-stream',
  };
}

export async function GET(_request, { params }) {
  try {
    const blob = await readLegacyBlob(params);
    if (blob.error) return new NextResponse(blob.error, { status: blob.status });

    return new NextResponse(blob.data, {
      status: 200,
      headers: {
        'Content-Type': blob.mimeType,
        'Content-Length': String(blob.data.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Legacy-Media': 'netlify-blobs-read-only',
      },
    });
  } catch (error) {
    console.error('Legacy Media Read Error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

export async function HEAD(_request, { params }) {
  try {
    const blob = await readLegacyBlob(params);
    if (blob.error) return new NextResponse(null, { status: blob.status });

    return new NextResponse(null, {
      status: 200,
      headers: {
        'Content-Type': blob.mimeType,
        'Content-Length': String(blob.data.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Legacy-Media': 'netlify-blobs-read-only',
      },
    });
  } catch (error) {
    console.error('Legacy Media Head Error:', error);
    return new NextResponse(null, { status: 500 });
  }
}
