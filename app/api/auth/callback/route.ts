import { NextRequest, NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  authConfig,
  clearAuthCookies,
  cookieSecureForRequest,
  createSessionToken,
  isEmailAllowed,
  oauthStateCookieValue,
  originFor,
} from '@/lib/auth';
import { RATE_LIMIT_POLICIES, consumeRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfo = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

function authError(message: string, status = 400) {
  return new NextResponse(message, { status });
}

export async function GET(request: NextRequest) {
  const config = authConfig();
  if (config.configError || config.authMode !== 'google' || !config.clientId || !config.clientSecret || !config.cookieSecret) {
    return authError('Authentication configuration error. Set AGENT_WORKSPACE_AUTH_MODE and required credentials.', 503);
  }

  const result = await consumeRateLimit(request, RATE_LIMIT_POLICIES.oauthCallback);
  if (!result.allowed) return rateLimitExceededResponse(result);

  const url = request.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = oauthStateCookieValue(request);
  if (!code || !state || !expectedState || state !== expectedState) {
    return authError('Invalid Google sign-in state.', 400);
  }

  const origin = originFor(request);
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: `${origin}/api/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tokenJson = (await tokenResponse.json()) as GoogleTokenResponse;
  if (!tokenResponse.ok || !tokenJson.access_token) {
    return authError(tokenJson.error_description || tokenJson.error || 'Google token exchange failed.', 502);
  }

  const bearerToken = 'Bearer ' + tokenJson.access_token;
  const userInfoHeaders = new Headers();
  userInfoHeaders.set('Authorization', bearerToken);
  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: userInfoHeaders,
  });
  const userInfo = (await userInfoResponse.json()) as GoogleUserInfo;

  const email = userInfo.email?.toLowerCase();
  if (!userInfoResponse.ok || !email || !userInfo.email_verified) {
    return authError('Google account email could not be verified.', 403);
  }
  if (!isEmailAllowed(email, config.allowedEmails)) {
    return authError('This Google account is not allowed for Agent Workspace.', 403);
  }

  const sessionToken = await createSessionToken({ email, name: userInfo.name, picture: userInfo.picture }, config.cookieSecret);
  const response = NextResponse.redirect(new URL('/', origin));
  clearAuthCookies(response);
  response.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecureForRequest(request, config.appBaseUrl),
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
