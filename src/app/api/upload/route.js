import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return NextResponse.json({ error: '파일이 없습니다.' }, { status: 400 });
    }

    const filename = file.name;
    const extension = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')) : '';
    const uniqueKey = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}${extension}`;
    
    const mimeType = file.type || 'application/octet-stream';

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Initialize Netlify Blobs store
    const store = getStore('media-store');

    // Save to store with metadata
    await store.set(uniqueKey, buffer, {
      metadata: {
        mimeType: mimeType,
      },
    });

    // Generate absolute URL
    const fileUrl = new URL(`/api/media/${uniqueKey}`, request.nextUrl.origin).toString();

    return NextResponse.json({ 
      success: true, 
      url: fileUrl, 
      mediaType: mimeType.startsWith('video/') ? 'video' : 'image' 
    });

  } catch (error) {
    console.error('Upload Error:', error);
    return NextResponse.json({ error: `업로드 실패: ${error.message}` }, { status: 500 });
  }
}
