import { NextResponse } from 'next/server';
import { MediaValidationError } from '@/lib/media-validation';
import { SupabaseStorageError, createStagingUpload } from '@/lib/supabase-storage';

export function apiErrorResponse(error, fallback = '미디어 요청 처리에 실패했습니다.') {
  const knownError = error instanceof MediaValidationError || error instanceof SupabaseStorageError;
  const status = knownError ? error.status : 500;
  const code = knownError ? error.code : 'INTERNAL_ERROR';

  if (!knownError) console.error('Media API Error:', error);

  return NextResponse.json({
    success: false,
    error: knownError ? error.message : fallback,
    code,
  }, { status });
}

export function uploadContractResponse() {
  return NextResponse.json({
    endpoint: '/api/upload/sign',
    alias: '/api/upload',
    request: {
      method: 'POST',
      contentType: 'application/json',
      body: {
        filename: 'example.jpg',
        contentType: 'image/jpeg',
        size: 123456,
      },
    },
    limits: {
      standardUpload: 'size <= 6 MiB',
      tusUpload: 'size > 6 MiB',
      image: 'image/jpeg 또는 image/png, 최대 8 MiB, 실제 너비 320~1440px',
      video: 'video/mp4 또는 video/quicktime, 최대 1 GiB',
    },
    standardClient: {
      instruction: 'upload.standard의 URL/메서드/헤더를 그대로 사용하고 raw File을 body로 PUT합니다.',
      example: "fetch(upload.standard.url, { method: 'PUT', headers: upload.standard.headers, body: file })",
    },
    tusClient: {
      instruction: 'tus-js-client에 upload.tus의 endpoint, headers, chunkSize, metadata를 그대로 전달합니다.',
      requiredChunkSize: 6291456,
    },
    complete: {
      instruction: '업로드 성공 뒤 completion.url로 completion.body를 JSON POST합니다.',
      response: '{ success, url, mediaType, contentType, size, width?, height?, path, verified }',
    },
    note: 'Netlify Blobs multipart 신규 업로드는 종료됐으며 /api/media/:key는 기존 파일 읽기 전용입니다.',
  });
}

export async function signedUploadPost(request) {
  try {
    const requestType = request.headers.get('content-type') || '';
    if (!requestType.toLowerCase().includes('application/json')) {
      return NextResponse.json({
        success: false,
        error: '신규 미디어는 JSON으로 signed upload 정보를 발급받아 Supabase에 직접 업로드해야 합니다.',
        code: 'SIGNED_UPLOAD_REQUIRED',
        contract: '/api/upload/sign',
      }, { status: 415 });
    }

    const input = await request.json();
    const plan = await createStagingUpload(input);
    return NextResponse.json({ success: true, ...plan }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({
        success: false,
        error: 'JSON 요청 본문이 올바르지 않습니다.',
        code: 'INVALID_JSON',
      }, { status: 400 });
    }
    return apiErrorResponse(error, '업로드 URL 발급에 실패했습니다.');
  }
}
