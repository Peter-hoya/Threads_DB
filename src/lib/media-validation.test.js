// Run with Node 22+: node --test src/lib/media-validation.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_MAX_BYTES,
  STANDARD_UPLOAD_MAX_BYTES,
  VIDEO_MAX_BYTES,
  MediaValidationError,
  assertActualMedia,
  assertUploadDeclaration,
  inspectIsoBaseMedia,
  inspectJpeg,
  inspectPng,
} from './media-validation.js';

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function jpegHeader(width, height) {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x11,
    0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function ftypHeader(majorBrand = 'mp42') {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    ...Buffer.from(majorBrand, 'ascii'),
    0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x32,
  ]);
}

test('업로드 선언은 6MiB 초과부터 TUS를 선택한다', () => {
  const standard = assertUploadDeclaration({
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    size: STANDARD_UPLOAD_MAX_BYTES,
  });
  const tus = assertUploadDeclaration({
    filename: 'photo.png',
    contentType: 'image/png',
    size: STANDARD_UPLOAD_MAX_BYTES + 1,
  });
  assert.equal(standard.uploadProtocol, 'standard');
  assert.equal(tus.uploadProtocol, 'tus');
});

test('이미지와 동영상 크기 상한을 각각 적용한다', () => {
  assert.doesNotThrow(() => assertUploadDeclaration({
    filename: 'photo.png', contentType: 'image/png', size: IMAGE_MAX_BYTES,
  }));
  assert.doesNotThrow(() => assertUploadDeclaration({
    filename: 'movie.mp4', contentType: 'video/mp4', size: VIDEO_MAX_BYTES,
  }));
  assert.throws(
    () => assertUploadDeclaration({
      filename: 'photo.png', contentType: 'image/png', size: IMAGE_MAX_BYTES + 1,
    }),
    (error) => error instanceof MediaValidationError && error.code === 'FILE_TOO_LARGE',
  );
});

test('허용되지 않은 MIME과 빈 파일을 거부한다', () => {
  assert.throws(
    () => assertUploadDeclaration({ filename: 'image.webp', contentType: 'image/webp', size: 100 }),
    (error) => error.code === 'UNSUPPORTED_CONTENT_TYPE',
  );
  assert.throws(
    () => assertUploadDeclaration({ filename: 'image.jpg', contentType: 'image/jpeg', size: 0 }),
    (error) => error.code === 'INVALID_FILE_SIZE',
  );
});

test('PNG 실제 크기를 IHDR에서 읽는다', () => {
  assert.deepEqual(inspectPng(pngHeader(1440, 1080)), {
    format: 'png', width: 1440, height: 1080,
  });
});

test('JPEG 실제 크기를 SOF에서 읽는다', () => {
  assert.deepEqual(inspectJpeg(jpegHeader(1080, 1350)), {
    format: 'jpeg', width: 1080, height: 1350,
  });
});

test('이미지 실제 너비 320~1440 경계를 검증한다', () => {
  const min = pngHeader(320, 400);
  const max = jpegHeader(1440, 1800);
  assert.equal(assertActualMedia({ bytes: min, contentType: 'image/png', size: min.length }).width, 320);
  assert.equal(assertActualMedia({ bytes: max, contentType: 'image/jpeg', size: max.length }).width, 1440);

  const tooSmall = pngHeader(319, 400);
  assert.throws(
    () => assertActualMedia({ bytes: tooSmall, contentType: 'image/png', size: tooSmall.length }),
    (error) => error.code === 'IMAGE_WIDTH_OUT_OF_RANGE',
  );
});

test('MP4와 QuickTime의 ISO BMFF ftyp 서명을 검증한다', () => {
  assert.deepEqual(inspectIsoBaseMedia(ftypHeader('mp42')), {
    format: 'iso-bmff', majorBrand: 'mp42',
  });
  const quickTime = assertActualMedia({
    bytes: ftypHeader('qt  '),
    contentType: 'video/quicktime',
    size: 1024,
  });
  assert.equal(quickTime.majorBrand, 'qt  ');
  assert.throws(
    () => inspectIsoBaseMedia(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])),
    (error) => error.code === 'INVALID_VIDEO_SIGNATURE',
  );
});
