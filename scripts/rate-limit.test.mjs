import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function loadRateLimit() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/rate-limit.ts']);
  const modulePath = path.join(outDir, 'lib/rate-limit.js');
  delete require.cache[modulePath];
  return { rateLimit: require(modulePath), cleanup };
}

function request({ headers = {}, cookies = {} } = {}) {
  return {
    headers: new Headers(headers),
    cookies: {
      get(name) {
        const value = cookies[name];
        return value === undefined ? undefined : { value };
      },
    },
  };
}

test('fixed-window limiter reports boundaries, reset, retry, and exact 429 response headers', async () => {
  const originalNow = Date.now;
  Date.now = () => 100_000;
  const { rateLimit, cleanup } = loadRateLimit();
  const policy = { name: 'test-boundary', limit: 2, windowSeconds: 10 };
  try {
    const client = request({ headers: { 'x-real-ip': '192.0.2.10' } });
    assert.deepEqual(await rateLimit.consumeRateLimit(client, policy), {
      allowed: true, limit: 2, remaining: 1, reset: 110, retryAfter: 0,
    });
    assert.deepEqual(await rateLimit.consumeRateLimit(client, policy), {
      allowed: true, limit: 2, remaining: 0, reset: 110, retryAfter: 0,
    });
    const denied = await rateLimit.consumeRateLimit(client, policy);
    assert.deepEqual(denied, {
      allowed: false, limit: 2, remaining: 0, reset: 110, retryAfter: 10,
    });
    const response = rateLimit.rateLimitExceededResponse(denied);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'Too many requests' });
    assert.equal(response.headers.get('retry-after'), '10');
    assert.equal(response.headers.get('ratelimit-limit'), '2');
    assert.equal(response.headers.get('ratelimit-remaining'), '0');
    assert.equal(response.headers.get('ratelimit-reset'), '110');

    Date.now = () => 110_000;
    assert.deepEqual(await rateLimit.consumeRateLimit(client, policy), {
      allowed: true, limit: 2, remaining: 1, reset: 120, retryAfter: 0,
    });
  } finally {
    Date.now = originalNow;
    cleanup();
  }
});

test('client keys ignore rotating unverified credentials and never retain raw IPs', async () => {
  const { rateLimit, cleanup } = loadRateLimit();
  const policy = { name: 'test-key', limit: 2, windowSeconds: 60 };
  try {
    const firstCredentials = await rateLimit.rateLimitKeyForRequest(request({
      headers: {
        authorization: 'Basic first-attacker-value',
        cookie: 'agent_workspace_session=fake-session-one',
        'x-forwarded-for': '203.0.113.4, 10.0.0.1',
      },
    }), policy);
    const rotatedCredentials = await rateLimit.rateLimitKeyForRequest(request({
      headers: {
        authorization: 'Basic second-attacker-value',
        cookie: 'agent_workspace_session=fake-session-two; kira_ws_session=fake-legacy',
        'x-forwarded-for': '203.0.113.4',
      },
    }), policy);
    assert.equal(firstCredentials, rotatedCredentials);

    const differentForwarded = await rateLimit.rateLimitKeyForRequest(request({
      headers: { 'x-forwarded-for': '203.0.113.5' },
    }), policy);
    assert.notEqual(firstCredentials, differentForwarded);

    const realIp = await rateLimit.rateLimitKeyForRequest(request({ headers: { 'x-real-ip': '198.51.100.8' } }), policy);
    const unknown = await rateLimit.rateLimitKeyForRequest(request(), policy);
    assert.notEqual(realIp, unknown);

    for (const key of [firstCredentials, rotatedCredentials, differentForwarded, realIp, unknown]) {
      assert.match(key, /^test-key:[0-9a-f]{64}$/);
      for (const raw of ['first-attacker-value', 'second-attacker-value', 'fake-session', '203.0.113.4', '198.51.100.8']) {
        assert.equal(key.includes(raw), false);
      }
    }
  } finally {
    cleanup();
  }
});

test('limiter stays at 5000 keys, evicts oldest deterministically, and prunes expired buckets', async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  const { rateLimit, cleanup } = loadRateLimit();
  const policy = { name: 'test-capacity', limit: 1, windowSeconds: 60 };
  try {
    for (let index = 0; index < 5_000; index += 1) {
      await rateLimit.consumeRateLimit(request({ headers: { 'x-real-ip': `192.0.2.${index}` } }), policy);
    }
    const before = rateLimit.getRateLimitStatsForTests();
    assert.equal(before.size, 5_000);
    const oldestKey = before.keys[0];

    await rateLimit.consumeRateLimit(request({ headers: { 'x-real-ip': '198.51.100.1' } }), policy);
    const afterEviction = rateLimit.getRateLimitStatsForTests();
    assert.equal(afterEviction.size, 5_000);
    assert.equal(afterEviction.keys.includes(oldestKey), false);

    Date.now = () => 1_080_000;
    await rateLimit.consumeRateLimit(request({ headers: { 'x-real-ip': '203.0.113.1' } }), policy);
    assert.equal(rateLimit.getRateLimitStatsForTests().size, 1);
  } finally {
    Date.now = originalNow;
    cleanup();
  }
});

test('auth routes and proxy wire the intended policies without rate-limiting read-only traffic', () => {
  const proxy = readFileSync(path.join(rootDir, 'proxy.ts'), 'utf8');
  const login = readFileSync(path.join(rootDir, 'app/api/auth/login/route.ts'), 'utf8');
  const callback = readFileSync(path.join(rootDir, 'app/api/auth/callback/route.ts'), 'utf8');
  const logout = readFileSync(path.join(rootDir, 'app/api/auth/logout/route.ts'), 'utf8');

  assert.match(proxy, /RATE_LIMIT_POLICIES\.unsafeMutation/);
  assert.match(proxy, /RATE_LIMIT_POLICIES\.expensivePost/);
  assert.match(proxy, /\['POST', 'PUT', 'PATCH', 'DELETE'\]/);
  assert.match(login, /RATE_LIMIT_POLICIES\.googleLogin/);
  assert.match(callback, /RATE_LIMIT_POLICIES\.oauthCallback/);
  assert.match(logout, /RATE_LIMIT_POLICIES\.unsafeMutation/);
  assert.equal(/consumeRateLimit/.test(login.slice(login.indexOf('export async function GET'), login.indexOf('const config'))), false);
});
