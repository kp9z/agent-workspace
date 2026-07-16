import { createHash, randomUUID } from 'node:crypto';

import type { Attachment } from './types';

export const MAX_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BASE64_PAYLOAD_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export type AttachmentInput = {
  id?: unknown;
  name?: unknown;
  mime_type?: unknown;
  data_url?: unknown;
  size_bytes?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isCanonicalAttachmentId(id: string) {
  return UUID_PATTERN.test(id.trim());
}

export function normalizeAttachmentId(rawId: unknown) {
  if (typeof rawId === 'string') {
    const trimmed = rawId.trim();
    if (isCanonicalAttachmentId(trimmed)) return trimmed.toLowerCase();
  }
  return randomUUID();
}

export function attachmentStorageId(rawId: string) {
  const trimmed = rawId.trim();
  if (isCanonicalAttachmentId(trimmed)) return trimmed.toLowerCase();
  const digest = createHash('sha256').update(trimmed).digest('hex').slice(0, 32);
  return `legacy-${digest}`;
}

export function sanitizeAttachmentName(rawName: unknown, index = 1) {
  const fallback = `image-${index}`;
  if (typeof rawName !== 'string') return fallback;
  const sanitized = rawName
    .trim()
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069\\/]/g, '');
  const truncated = Array.from(sanitized)
    .slice(0, 120)
    .join('')
    .trim();
  return truncated || fallback;
}

function decodeStrictBase64(payload: string) {
  if (payload.length === 0) throw new Error('image data URL payload must not be empty');
  if (payload.length > MAX_BASE64_PAYLOAD_LENGTH) throw new Error(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
  if (payload.length % 4 !== 0) throw new Error('image data URL must use canonical base64');
  const paddingLength = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const dataLength = payload.length - paddingLength;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    const isAlphabet = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (index < dataLength ? !isAlphabet : code !== 61) {
      throw new Error('image data URL must use canonical base64');
    }
  }
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) throw new Error('image data URL payload must not be empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
  if (bytes.toString('base64') !== payload) throw new Error('image data URL must use canonical base64');
  return bytes;
}

function validateImageSignature(bytes: Buffer, mimeType: string) {
  if (mimeType === 'image/png') {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
      throw new Error('image data does not match declared image/png signature');
    }
    return;
  }

  if (mimeType === 'image/jpeg') {
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error('image data does not match declared image/jpeg signature');
    }
    return;
  }

  if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii');
    if (header !== 'GIF87a' && header !== 'GIF89a') {
      throw new Error('image data does not match declared image/gif signature');
    }
    return;
  }

  if (mimeType === 'image/webp') {
    if (bytes.length < 12) throw new Error('image data does not match declared image/webp signature');
    if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') {
      throw new Error('image data does not match declared image/webp signature');
    }
    return;
  }

  throw new Error(`unsupported image type: ${mimeType || 'unknown'}`);
}

function validateSizeBytes(rawSizeBytes: unknown, decodedLength: number) {
  if (typeof rawSizeBytes !== 'number' || !Number.isSafeInteger(rawSizeBytes) || rawSizeBytes <= 0) {
    throw new Error('image size_bytes must be a positive safe integer');
  }
  if (rawSizeBytes !== decodedLength) {
    throw new Error('image size_bytes must match decoded image length');
  }
}

export function validateAttachments(raw: unknown): Attachment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('attachments must be an array');
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments are supported`);

  return raw.map((item, index) => {
    const record = asRecord(item);
    if (!record) throw new Error(`attachment ${index + 1} is invalid`);

    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : '';
    if (!SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType)) throw new Error(`unsupported image type: ${mimeType || 'unknown'}`);

    const dataUrl = typeof record.data_url === 'string' ? record.data_url : '';
    const prefix = `data:${mimeType};base64,`;
    if (!dataUrl.startsWith(prefix)) {
      throw new Error('image must be sent as an exact matching data URL');
    }
    const payload = dataUrl.slice(prefix.length);
    const bytes = decodeStrictBase64(payload);
    validateImageSignature(bytes, mimeType);
    validateSizeBytes(record.size_bytes, bytes.length);

    return {
      id: normalizeAttachmentId(record.id),
      type: 'image',
      name: sanitizeAttachmentName(record.name, index + 1),
      mime_type: mimeType,
      data_url: `data:${mimeType};base64,${bytes.toString('base64')}`,
      size_bytes: bytes.length,
    };
  });
}
