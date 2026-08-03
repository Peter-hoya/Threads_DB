const MEBIBYTE = 1024 * 1024;

export const STANDARD_UPLOAD_MAX_BYTES = 6 * MEBIBYTE;
export const IMAGE_MAX_BYTES = 8 * MEBIBYTE;
export const VIDEO_MAX_BYTES = 1024 * MEBIBYTE;
export const IMAGE_MIN_WIDTH = 320;
export const IMAGE_MAX_WIDTH = 1440;

export const ALLOWED_MEDIA_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'video/mp4',
  'video/quicktime',
]);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

export class MediaValidationError extends Error {
  constructor(message, { code = 'INVALID_MEDIA', status = 400 } = {}) {
    super(message);
    this.name = 'MediaValidationError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

export function getMediaType(contentType) {
  const normalized = normalizeContentType(contentType);
  if (IMAGE_TYPES.has(normalized)) return 'image';
  if (VIDEO_TYPES.has(normalized)) return 'video';
  return null;
}

export function getExtensionForContentType(contentType) {
  switch (normalizeContentType(contentType)) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'video/mp4': return '.mp4';
    case 'video/quicktime': return '.mov';
    default: return '';
  }
}

export function assertUploadDeclaration(
  { filename, contentType, size },
  { maxVideoBytes = VIDEO_MAX_BYTES } = {},
) {
  const normalizedContentType = normalizeContentType(contentType);
  const mediaType = getMediaType(normalizedContentType);
  const numericSize = Number(size);

  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) {
    throw new MediaValidationError('파일명은 1~255자로 입력해야 합니다.', {
      code: 'INVALID_FILENAME',
    });
  }

  if (!mediaType) {
    throw new MediaValidationError(
      `지원하지 않는 미디어 형식입니다. 허용 형식: ${ALLOWED_MEDIA_TYPES.join(', ')}`,
      { code: 'UNSUPPORTED_CONTENT_TYPE', status: 415 },
    );
  }

  if (!Number.isSafeInteger(numericSize) || numericSize <= 0) {
    throw new MediaValidationError('파일 크기는 1바이트 이상의 정수여야 합니다.', {
      code: 'INVALID_FILE_SIZE',
    });
  }

  const maxBytes = mediaType === 'image' ? IMAGE_MAX_BYTES : maxVideoBytes;
  if (numericSize > maxBytes) {
    const maxLabel = mediaType === 'image'
      ? '8MB'
      : `${Math.floor(maxVideoBytes / MEBIBYTE)}MB`;
    throw new MediaValidationError(`${mediaType === 'image' ? '이미지' : '동영상'}는 ${maxLabel}를 초과할 수 없습니다.`, {
      code: 'FILE_TOO_LARGE',
      status: 413,
    });
  }

  return {
    filename: filename.trim(),
    contentType: normalizedContentType,
    mediaType,
    size: numericSize,
    maxBytes,
    uploadProtocol: numericSize > STANDARD_UPLOAD_MAX_BYTES ? 'tus' : 'standard',
  };
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new MediaValidationError('미디어 바이트 데이터가 필요합니다.', {
    code: 'INVALID_MEDIA_BYTES',
  });
}

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes, offset) {
  return (
    (bytes[offset] * 0x1000000)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  );
}

function readAscii(bytes, offset, length) {
  let result = '';
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    result += String.fromCharCode(bytes[index]);
  }
  return result;
}

export function inspectPng(bytesInput) {
  const bytes = toUint8Array(bytesInput);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    throw new MediaValidationError('PNG 파일 서명이 올바르지 않습니다.', {
      code: 'INVALID_PNG_SIGNATURE',
      status: 415,
    });
  }

  if (readUint32BE(bytes, 8) !== 13 || readAscii(bytes, 12, 4) !== 'IHDR') {
    throw new MediaValidationError('PNG IHDR 헤더를 찾을 수 없습니다.', {
      code: 'INVALID_PNG_HEADER',
      status: 415,
    });
  }

  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width <= 0 || height <= 0) {
    throw new MediaValidationError('PNG 이미지 크기가 올바르지 않습니다.', {
      code: 'INVALID_IMAGE_DIMENSIONS',
      status: 415,
    });
  }

  return { format: 'png', width, height };
}

export function inspectJpeg(bytesInput) {
  const bytes = toUint8Array(bytesInput);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new MediaValidationError('JPEG 파일 서명이 올바르지 않습니다.', {
      code: 'INVALID_JPEG_SIGNATURE',
      status: 415,
    });
  }

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;

    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new MediaValidationError('JPEG 세그먼트 길이가 올바르지 않습니다.', {
        code: 'INVALID_JPEG_HEADER',
        status: 415,
      });
    }

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        throw new MediaValidationError('JPEG 크기 헤더가 올바르지 않습니다.', {
          code: 'INVALID_JPEG_HEADER',
          status: 415,
        });
      }
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      if (width <= 0 || height <= 0) {
        throw new MediaValidationError('JPEG 이미지 크기가 올바르지 않습니다.', {
          code: 'INVALID_IMAGE_DIMENSIONS',
          status: 415,
        });
      }
      return { format: 'jpeg', width, height };
    }

    offset += segmentLength;
  }

  throw new MediaValidationError('JPEG 이미지 크기 헤더를 찾을 수 없습니다.', {
    code: 'JPEG_DIMENSIONS_NOT_FOUND',
    status: 415,
  });
}

export function inspectIsoBaseMedia(bytesInput) {
  const bytes = toUint8Array(bytesInput);
  let offset = 0;
  const scanLimit = Math.min(bytes.length, 64 * 1024);

  while (offset + 8 <= scanLimit) {
    let boxSize = readUint32BE(bytes, offset);
    const boxType = readAscii(bytes, offset + 4, 4);
    let headerSize = 8;

    if (boxSize === 1) {
      if (offset + 16 > scanLimit) break;
      const high = readUint32BE(bytes, offset + 8);
      const low = readUint32BE(bytes, offset + 12);
      boxSize = high * 0x100000000 + low;
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = scanLimit - offset;
    }

    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize) break;

    if (boxType === 'ftyp') {
      if (offset + headerSize + 4 > bytes.length) {
        throw new MediaValidationError('동영상 ftyp 헤더가 잘렸습니다.', {
          code: 'INVALID_VIDEO_HEADER',
          status: 415,
        });
      }
      return {
        format: 'iso-bmff',
        majorBrand: readAscii(bytes, offset + headerSize, 4),
      };
    }

    offset += boxSize;
  }

  throw new MediaValidationError('MP4/QuickTime ftyp 파일 서명을 찾을 수 없습니다.', {
    code: 'INVALID_VIDEO_SIGNATURE',
    status: 415,
  });
}

export function assertActualMedia({ bytes, contentType, size }) {
  const normalizedContentType = normalizeContentType(contentType);
  const mediaType = getMediaType(normalizedContentType);
  const numericSize = Number(size);

  if (!mediaType) {
    throw new MediaValidationError('저장된 파일의 Content-Type이 허용되지 않습니다.', {
      code: 'UNSUPPORTED_STORED_CONTENT_TYPE',
      status: 415,
    });
  }

  const maxBytes = mediaType === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (!Number.isSafeInteger(numericSize) || numericSize <= 0 || numericSize > maxBytes) {
    throw new MediaValidationError('저장된 파일의 실제 크기가 허용 범위를 벗어났습니다.', {
      code: 'INVALID_STORED_FILE_SIZE',
      status: numericSize > maxBytes ? 413 : 415,
    });
  }

  if (mediaType === 'image') {
    const dimensions = normalizedContentType === 'image/png'
      ? inspectPng(bytes)
      : inspectJpeg(bytes);

    if (dimensions.width < IMAGE_MIN_WIDTH || dimensions.width > IMAGE_MAX_WIDTH) {
      throw new MediaValidationError(
        `이미지 너비는 ${IMAGE_MIN_WIDTH}~${IMAGE_MAX_WIDTH}px여야 합니다. 현재 ${dimensions.width}px입니다.`,
        { code: 'IMAGE_WIDTH_OUT_OF_RANGE', status: 422 },
      );
    }

    return {
      mediaType,
      contentType: normalizedContentType,
      size: numericSize,
      ...dimensions,
    };
  }

  return {
    mediaType,
    contentType: normalizedContentType,
    size: numericSize,
    ...inspectIsoBaseMedia(bytes),
  };
}
