import { NextRequest, NextResponse } from 'next/server';
import { authConfig, clearAuthCookies, originFor } from '@/lib/auth';
import { RATE_LIMIT_POLICIES, consumeRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { validateUnsafeRequestOrigin } from '@/lib/request-safety';

function methodNotAllowed() {
  return new NextResponse('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}

export async function GET() {
  return methodNotAllowed();
}

export async function POST(request: NextRequest) {
  const originCheck = validateUnsafeRequestOrigin(request, authConfig().appBaseUrl);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.error }, { status: originCheck.status });
  }

  const result = await consumeRateLimit(request, RATE_LIMIT_POLICIES.unsafeMutation);
  if (!result.allowed) return rateLimitExceededResponse(result);

  const origin = originFor(request);
  const destination = authConfig().authMode === 'google' ? new URL('/api/auth/login', origin) : new URL('/', origin);
  const response = NextResponse.redirect(destination, 303);
  clearAuthCookies(response);
  return response;
}
