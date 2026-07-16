import { NextRequest, NextResponse } from 'next/server';
import {
  authConfig,
  constantTimeSecretEquals,
  sessionCookieValue,
  verifySessionToken,
} from '@/lib/auth';
import {
  RATE_LIMIT_POLICIES,
  consumeRateLimit,
  rateLimitExceededResponse,
} from '@/lib/rate-limit';
import { validateUnsafeRequestOrigin } from '@/lib/request-safety';

async function basicAuthAllowed(request: NextRequest, secret: string | undefined) {
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    const password = decoded.slice(separator + 1);
    return await constantTimeSecretEquals(password, secret);
  } catch {
    return false;
  }
}

function configurationErrorResponse() {
  return new NextResponse('Authentication configuration error. Set AGENT_WORKSPACE_AUTH_MODE and required credentials.', { status: 503 });
}

function unauthenticatedResponse(request: NextRequest, googleMode: boolean) {
  if (googleMode && request.method === 'GET' && !request.nextUrl.pathname.startsWith('/api/')) {
    const loginUrl = new URL('/api/auth/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (googleMode) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Agent Workspace"' },
  });
}

function isExpensiveMutation(request: NextRequest) {
  if (request.method !== 'POST') return false;
  const pathname = request.nextUrl.pathname;
  return pathname === '/api/queue' || /^\/api\/sessions\/[^/]+\/messages$/.test(pathname);
}

export async function proxy(request: NextRequest) {
  const originCheck = validateUnsafeRequestOrigin(request, authConfig().appBaseUrl);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.error }, { status: originCheck.status });
  }

  const config = authConfig();
  if (config.configError) return configurationErrorResponse();

  const isUnsafeMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase());
  if (isUnsafeMethod) {
    const unsafeResult = await consumeRateLimit(request, RATE_LIMIT_POLICIES.unsafeMutation);
    if (!unsafeResult.allowed) return rateLimitExceededResponse(unsafeResult);

    if (isExpensiveMutation(request)) {
      const expensiveResult = await consumeRateLimit(request, RATE_LIMIT_POLICIES.expensivePost);
      if (!expensiveResult.allowed) return rateLimitExceededResponse(expensiveResult);
    }
  }

  if (config.authMode === 'none') return NextResponse.next();

  if (config.authMode === 'shared-secret') {
    if (await basicAuthAllowed(request, config.sharedSecret)) return NextResponse.next();
    const session = await verifySessionToken(sessionCookieValue(request), config.cookieSecret);
    if (session) return NextResponse.next();
  } else if (config.authMode === 'google') {
    const session = await verifySessionToken(sessionCookieValue(request), config.cookieSecret);
    if (session) return NextResponse.next();
  }

  return unauthenticatedResponse(request, config.authMode === 'google');
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.png|apple-touch-icon.png|icon-192.png|icon-512.png|manifest.json|api/auth).*)'],
};
