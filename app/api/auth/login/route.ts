import { NextRequest, NextResponse } from 'next/server';
import { OAUTH_STATE_COOKIE, authConfig, clearAuthCookies, cookieSecureForRequest, originFor } from '@/lib/auth';
import { RATE_LIMIT_POLICIES, consumeRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';

export async function GET(request: NextRequest) {
  const config = authConfig();
  if (config.configError || config.authMode !== 'google' || !config.clientId) {
    return new NextResponse('Authentication configuration error. Set AGENT_WORKSPACE_AUTH_MODE and required credentials.', { status: 503 });
  }

  const result = await consumeRateLimit(request, RATE_LIMIT_POLICIES.googleLogin);
  if (!result.allowed) return rateLimitExceededResponse(result);

  const state = crypto.randomUUID();
  const origin = originFor(request);
  const redirectUri = `${origin}/api/auth/callback`;
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.searchParams.set('client_id', config.clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', 'openid email profile');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('prompt', 'select_account');

  const response = NextResponse.redirect(authorizationUrl);
  clearAuthCookies(response);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecureForRequest(request, config.appBaseUrl),
    path: '/',
    maxAge: 60 * 10,
  });
  return response;
}
