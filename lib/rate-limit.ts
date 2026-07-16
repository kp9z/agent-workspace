import type { NextRequest } from 'next/server';

const encoder = new TextEncoder();
const MAX_KEYS = 5_000;
const MAX_SOURCE_LENGTH = 256;

export type RateLimitPolicy = {
  name: string;
  limit: number;
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter: number;
};

type RequestLike = Pick<NextRequest, 'headers'>;

type BucketState = {
  windowStart: number;
  windowSeconds: number;
  count: number;
};

const buckets = new Map<string, BucketState>();

export const RATE_LIMIT_POLICIES = {
  unsafeMutation: { name: 'unsafe-mutation', limit: 120, windowSeconds: 60 },
  expensivePost: { name: 'expensive-post', limit: 30, windowSeconds: 60 },
  googleLogin: { name: 'google-login', limit: 20, windowSeconds: 10 * 60 },
  oauthCallback: { name: 'oauth-callback', limit: 60, windowSeconds: 10 * 60 },
} as const satisfies Record<string, RateLimitPolicy>;

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizedCredentialSource(value: string) {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[\u0000-\u001f\u007f]/g, '');
  return sanitized.length > MAX_SOURCE_LENGTH ? sanitized.slice(0, MAX_SOURCE_LENGTH) : sanitized;
}

function firstHeaderValue(value: string | null | undefined) {
  if (!value) return undefined;
  const first = value.split(',')[0];
  const normalized = normalizedCredentialSource(first);
  return normalized || undefined;
}

function rateLimitSource(request: RequestLike) {
  // Authentication material is attacker-controlled until verification and must
  // never create fresh pre-authentication buckets when rotated.
  const forwardedFor = firstHeaderValue(request.headers.get('x-forwarded-for'));
  if (forwardedFor) return forwardedFor;

  const realIp = firstHeaderValue(request.headers.get('x-real-ip'));
  if (realIp) return realIp;

  return 'unknown';
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bucketKey(policy: RateLimitPolicy, sourceHash: string) {
  return `${policy.name}:${sourceHash}`;
}

function pruneExpiredBuckets(now = nowEpochSeconds()) {
  for (const [key, bucket] of buckets) {
    if (bucket.windowStart + bucket.windowSeconds <= now) {
      buckets.delete(key);
    }
  }
}

function evictOldestBucket() {
  const oldest = buckets.keys().next().value as string | undefined;
  if (oldest !== undefined) buckets.delete(oldest);
}

function currentWindowStart(now: number, windowSeconds: number) {
  return Math.floor(now / windowSeconds) * windowSeconds;
}

export async function rateLimitKeyForRequest(request: RequestLike, policy: RateLimitPolicy) {
  const source = normalizedCredentialSource(rateLimitSource(request));
  const sourceHash = await sha256Hex(`${policy.name}:${source}`);
  return bucketKey(policy, sourceHash);
}

export async function consumeRateLimit(request: RequestLike, policy: RateLimitPolicy): Promise<RateLimitResult> {
  const key = await rateLimitKeyForRequest(request, policy);
  const now = nowEpochSeconds();
  const windowStart = currentWindowStart(now, policy.windowSeconds);
  const reset = windowStart + policy.windowSeconds;
  const existing = buckets.get(key);

  let bucket: BucketState;
  if (existing && existing.windowStart === windowStart) {
    bucket = existing;
  } else {
    if (!existing) {
      pruneExpiredBuckets(now);
      while (buckets.size >= MAX_KEYS) evictOldestBucket();
    }
    bucket = { windowStart, windowSeconds: policy.windowSeconds, count: 0 };
    buckets.set(key, bucket);
  }

  if (bucket.count >= policy.limit) {
    return {
      allowed: false,
      limit: policy.limit,
      remaining: 0,
      reset,
      retryAfter: Math.max(0, reset - now),
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    limit: policy.limit,
    remaining: policy.limit - bucket.count,
    reset,
    retryAfter: 0,
  };
}

export function rateLimitExceededResponse(result: RateLimitResult) {
  return Response.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfter),
        'RateLimit-Limit': String(result.limit),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(result.reset),
      },
    },
  );
}

export function resetRateLimitStateForTests() {
  buckets.clear();
}

export function getRateLimitStatsForTests() {
  return {
    size: buckets.size,
    keys: [...buckets.keys()],
    entries: [...buckets.entries()].map(([key, bucket]) => ({ key, windowStart: bucket.windowStart, count: bucket.count })),
  };
}
