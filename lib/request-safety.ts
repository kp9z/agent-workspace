import type { NextRequest } from 'next/server';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type UnsafeRequestOriginFailure = {
  ok: false;
  status: 403;
  error: string;
};

export type UnsafeRequestOriginSuccess = {
  ok: true;
};

export type UnsafeRequestOriginResult = UnsafeRequestOriginSuccess | UnsafeRequestOriginFailure;

function validatedOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const isOriginOnly = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isOriginOnly) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function expectedOrigin(request: Pick<NextRequest, 'nextUrl'>, appBaseUrl?: string) {
  return validatedOrigin(appBaseUrl) || request.nextUrl.origin;
}

export function validateUnsafeRequestOrigin(
  request: Pick<NextRequest, 'headers' | 'method' | 'nextUrl'>,
  appBaseUrl?: string,
): UnsafeRequestOriginResult {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) {
    return { ok: true };
  }

  const origin = request.headers.get('origin');
  const destinationOrigin = expectedOrigin(request, appBaseUrl);

  if (origin !== null) {
    if (origin === 'null') {
      return { ok: false, status: 403, error: 'Cross-origin requests are not allowed' };
    }

    try {
      const parsed = new URL(origin);
      const isOriginOnly = parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
      if (!isOriginOnly || parsed.origin !== destinationOrigin) {
        return { ok: false, status: 403, error: 'Cross-origin requests are not allowed' };
      }
      return { ok: true };
    } catch {
      return { ok: false, status: 403, error: 'Cross-origin requests are not allowed' };
    }
  }

  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite?.toLowerCase() === 'cross-site') {
    return { ok: false, status: 403, error: 'Cross-origin requests are not allowed' };
  }

  return { ok: true };
}
