import type { NextRequest } from 'next/server';

export type AuthMode = 'google' | 'shared-secret' | 'none';

export type AuthConfig = {
  authMode: AuthMode;
  authEnabled: boolean;
  googleEnabled: boolean;
  clientId?: string;
  clientSecret?: string;
  cookieSecret?: string;
  allowedEmails: string[];
  sharedSecret?: string;
  appBaseUrl?: string;
  configError?: string;
};

export type SessionPayload = {
  email: string;
  name?: string;
  picture?: string;
  exp: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const SHARED_SECRET_MIN_LENGTH = 24;
export const SESSION_COOKIE = 'agent_workspace_session';
export const LEGACY_SESSION_COOKIE = 'kira_ws_session';
export const OAUTH_STATE_COOKIE = 'agent_workspace_oauth_state';
export const LEGACY_OAUTH_STATE_COOKIE = 'kira_ws_oauth_state';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function normalizedValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizedMode(value: string | undefined): AuthMode | undefined {
  const mode = normalizedValue(value)?.toLowerCase();
  if (mode === 'google' || mode === 'shared-secret' || mode === 'none') return mode;
  return undefined;
}

function parseAllowedEmails(value: string | undefined) {
  return normalizedValue(value)
    ?.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean) || [];
}

function hasAnyGoogleConfig(clientId?: string, clientSecret?: string, authCookieSecret?: string, allowedEmails?: string[]) {
  return Boolean(clientId || clientSecret || authCookieSecret || (allowedEmails && allowedEmails.length > 0));
}

function isCompleteGoogleConfig(clientId?: string, clientSecret?: string, authCookieSecret?: string, allowedEmails?: string[]) {
  return Boolean(clientId && clientSecret && authCookieSecret && (allowedEmails?.length || 0) > 0);
}

function isReasonableSharedSecret(secret?: string) {
  return Boolean(secret && secret.length >= SHARED_SECRET_MIN_LENGTH);
}

function appBaseUrlConfigError(value: string | undefined, mode: AuthMode | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const isOriginOnly = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isOriginOnly) {
      return 'APP_BASE_URL must be a valid absolute HTTP(S) origin.';
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (mode === 'google' && process.env.NODE_ENV === 'production' && url.protocol !== 'https:' && !loopback) {
      return 'APP_BASE_URL must use HTTPS for Google auth in production.';
    }
    return undefined;
  } catch {
    return 'APP_BASE_URL must be a valid absolute HTTP(S) origin.';
  }
}

function invalidAuthConfig(message: string): AuthConfig {
  return {
    authMode: 'none',
    authEnabled: false,
    googleEnabled: false,
    allowedEmails: [],
    configError: message,
  };
}

export function authConfig(): AuthConfig {
  const rawMode = normalizedValue(process.env.AGENT_WORKSPACE_AUTH_MODE);
  const explicitMode = normalizedMode(rawMode);
  const clientId = normalizedValue(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = normalizedValue(process.env.GOOGLE_CLIENT_SECRET);
  const authCookieSecret = normalizedValue(process.env.AUTH_COOKIE_SECRET);
  const allowedEmails = parseAllowedEmails(process.env.GOOGLE_ALLOWED_EMAILS);
  const sharedSecret = normalizedValue(process.env.APP_SHARED_SECRET);
  const appBaseUrl = normalizedValue(process.env.APP_BASE_URL);
  const completeGoogleConfig = isCompleteGoogleConfig(clientId, clientSecret, authCookieSecret, allowedEmails);
  const anyGoogleConfig = hasAnyGoogleConfig(clientId, clientSecret, authCookieSecret, allowedEmails);
  const sharedSecretValid = isReasonableSharedSecret(sharedSecret);

  if (rawMode && !explicitMode) {
    return invalidAuthConfig('AGENT_WORKSPACE_AUTH_MODE must be google, shared-secret, or none.');
  }

  const resolvedMode = explicitMode || (completeGoogleConfig ? 'google' : sharedSecretValid ? 'shared-secret' : undefined);
  const appBaseError = appBaseUrlConfigError(appBaseUrl, resolvedMode);
  if (appBaseError) return invalidAuthConfig(appBaseError);

  if (explicitMode === 'google') {
    if (!completeGoogleConfig) {
      return invalidAuthConfig('Google auth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_COOKIE_SECRET, and GOOGLE_ALLOWED_EMAILS.');
    }

    return {
      authMode: 'google',
      authEnabled: true,
      googleEnabled: true,
      clientId,
      clientSecret,
      cookieSecret: authCookieSecret,
      allowedEmails,
      sharedSecret,
      appBaseUrl,
    };
  }

  if (explicitMode === 'shared-secret') {
    if (!sharedSecretValid) {
      return invalidAuthConfig(`Shared-secret auth requires APP_SHARED_SECRET to be at least ${SHARED_SECRET_MIN_LENGTH} characters.`);
    }

    return {
      authMode: 'shared-secret',
      authEnabled: true,
      googleEnabled: false,
      clientId,
      clientSecret,
      cookieSecret: sharedSecret,
      allowedEmails,
      sharedSecret,
      appBaseUrl,
    };
  }

  if (explicitMode === 'none') {
    return {
      authMode: 'none',
      authEnabled: false,
      googleEnabled: false,
      clientId,
      clientSecret,
      cookieSecret: undefined,
      allowedEmails,
      sharedSecret,
      appBaseUrl,
    };
  }

  if (completeGoogleConfig) {
    return {
      authMode: 'google',
      authEnabled: true,
      googleEnabled: true,
      clientId,
      clientSecret,
      cookieSecret: authCookieSecret,
      allowedEmails,
      sharedSecret,
      appBaseUrl,
    };
  }

  if (sharedSecretValid) {
    return {
      authMode: 'shared-secret',
      authEnabled: true,
      googleEnabled: false,
      clientId,
      clientSecret,
      cookieSecret: sharedSecret,
      allowedEmails,
      sharedSecret,
      appBaseUrl,
    };
  }

  if (anyGoogleConfig) {
    return invalidAuthConfig('Google auth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_COOKIE_SECRET, and GOOGLE_ALLOWED_EMAILS.');
  }

  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return {
      authMode: 'none',
      authEnabled: false,
      googleEnabled: false,
      clientId,
      clientSecret,
      cookieSecret: undefined,
      allowedEmails,
      sharedSecret,
      appBaseUrl,
    };
  }

  return invalidAuthConfig('Authentication is not configured. Set AGENT_WORKSPACE_AUTH_MODE or required credentials.');
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeText(value: string) {
  return base64UrlEncodeBytes(textEncoder.encode(value));
}

function base64UrlDecodeBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlDecodeText(value: string) {
  return textDecoder.decode(base64UrlDecodeBytes(value));
}

async function hmacKey(secret: string, usage: KeyUsage[]) {
  return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

async function signValue(value: string, secret: string) {
  const key = await hmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function verifySignature(value: string, signature: string, secret: string) {
  const key = await hmacKey(secret, ['verify']);
  return crypto.subtle.verify('HMAC', key, base64UrlDecodeBytes(signature), textEncoder.encode(value));
}

async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)));
}

export async function constantTimeSecretEquals(candidate: string, expected: string) {
  const [candidateBytes, expectedBytes] = await Promise.all([sha256Bytes(candidate), sha256Bytes(expected)]);
  const length = Math.max(candidateBytes.length, expectedBytes.length);
  let diff = candidateBytes.length ^ expectedBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (candidateBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }

  return diff === 0;
}

export async function createSessionToken(payload: Omit<SessionPayload, 'exp'>, secret: string) {
  const header = base64UrlEncodeText(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncodeText(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  }));
  const unsigned = `${header}.${body}`;
  const signature = await signValue(unsigned, secret);
  return `${unsigned}.${signature}`;
}

export async function verifySessionToken(token: string | undefined, secret: string | undefined): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  try {
    const parsedHeader = JSON.parse(base64UrlDecodeText(header)) as { alg?: string };
    if (parsedHeader.alg !== 'HS256') return null;
    const valid = await verifySignature(`${header}.${body}`, signature, secret);
    if (!valid) return null;
    const payload = JSON.parse(base64UrlDecodeText(body)) as SessionPayload;
    if (!payload.email || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function isEmailAllowed(email: string, allowedEmails: string[]) {
  return allowedEmails.includes(email.toLowerCase());
}

export function sessionCookieValue(request: Pick<NextRequest, 'cookies'>) {
  return request.cookies.get(SESSION_COOKIE)?.value || request.cookies.get(LEGACY_SESSION_COOKIE)?.value;
}

export function oauthStateCookieValue(request: Pick<NextRequest, 'cookies'>) {
  return request.cookies.get(OAUTH_STATE_COOKIE)?.value || request.cookies.get(LEGACY_OAUTH_STATE_COOKIE)?.value;
}

export function clearAuthCookies(response: { cookies: { delete(name: string): void } }) {
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(LEGACY_SESSION_COOKIE);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(LEGACY_OAUTH_STATE_COOKIE);
}

function appBaseOrigin(appBaseUrl?: string) {
  if (!appBaseUrl) return undefined;
  try {
    return new URL(appBaseUrl).origin;
  } catch {
    return undefined;
  }
}

export function cookieSecureForRequest(request: Pick<NextRequest, 'headers' | 'nextUrl'>, appBaseUrl?: string) {
  const baseOrigin = appBaseOrigin(appBaseUrl);
  if (baseOrigin) return baseOrigin.startsWith('https://');

  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwardedProto) return forwardedProto === 'https';

  return request.nextUrl.protocol === 'https:';
}

export function originFor(request: NextRequest) {
  const baseOrigin = appBaseOrigin(authConfig().appBaseUrl);
  return baseOrigin || request.nextUrl.origin;
}
