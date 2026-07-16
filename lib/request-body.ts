const DEFAULT_JSON_LIMIT_BYTES = 256 * 1024;

export const JSON_BODY_GENERAL_LIMIT_BYTES = DEFAULT_JSON_LIMIT_BYTES;
// Three 4 MiB images expand to 16 MiB as base64; leave bounded room for JSON metadata.
export const JSON_BODY_ATTACHMENT_LIMIT_BYTES = 17 * 1024 * 1024;

export type JsonBodyParseFailure = {
  ok: false;
  status: 400 | 413 | 415;
  error: string;
};

export type JsonBodyParseSuccess<T> = {
  ok: true;
  value: T;
  bytesRead: number;
};

export type JsonBodyParseResult<T> = JsonBodyParseSuccess<T> | JsonBodyParseFailure;

function isJsonContentType(contentType: string | null) {
  if (!contentType) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || Boolean(mediaType?.startsWith('application/') && mediaType.endsWith('+json'));
}

function parseDeclaredLength(request: Request, limitBytes: number) {
  const raw = request.headers.get('content-length');
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const declared = Number(raw);
  if (!Number.isSafeInteger(declared) || declared < 0) return undefined;
  if (declared > limitBytes) {
    return { ok: false as const, status: 413 as const, error: 'Request body is too large' };
  }
  return undefined;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (!body || body.locked) return;
  try {
    await body.cancel('Request body rejected');
  } catch {
    // The connection may already be closed; rejection still wins.
  }
}

export function jsonBodyErrorResponse(error: JsonBodyParseFailure) {
  return Response.json({ error: error.error }, { status: error.status });
}

export async function parseJsonBody<T = unknown>(request: Request, limitBytes = DEFAULT_JSON_LIMIT_BYTES): Promise<JsonBodyParseResult<T>> {
  const declaredLengthError = parseDeclaredLength(request, limitBytes);
  if (declaredLengthError) {
    await cancelBody(request.body);
    return declaredLengthError;
  }

  if (!isJsonContentType(request.headers.get('content-type'))) {
    await cancelBody(request.body);
    return { ok: false, status: 415, error: 'Content-Type must be application/json' };
  }

  const body = request.body;
  if (!body) {
    return { ok: false, status: 400, error: 'Request body is empty' };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limitBytes) {
        try {
          await reader.cancel('Request body is too large');
        } catch {
          // The connection may already be closed; return the bounded rejection.
        }
        return { ok: false, status: 413, error: 'Request body is too large' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  if (bytesRead === 0) {
    return { ok: false, status: 400, error: 'Request body is empty' };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: 'JSON body is empty' };
  }

  try {
    return { ok: true, value: JSON.parse(text) as T, bytesRead };
  } catch {
    return { ok: false, status: 400, error: 'JSON body is malformed' };
  }
}
