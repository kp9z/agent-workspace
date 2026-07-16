import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function loadAuthModule() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/auth.ts']);
  const modulePath = path.join(outDir, 'lib/auth.js');
  delete require.cache[modulePath];
  const auth = require(modulePath);
  return { auth, cleanup };
}

test('auth helpers prefer canonical cookies and clear canonical plus legacy state', () => {
  const { auth, cleanup } = loadAuthModule();
  try {
    const request = {
      cookies: {
        get(name) {
          const values = {
            [auth.SESSION_COOKIE]: undefined,
            [auth.LEGACY_SESSION_COOKIE]: { value: 'legacy-session-token' },
            [auth.OAUTH_STATE_COOKIE]: undefined,
            [auth.LEGACY_OAUTH_STATE_COOKIE]: { value: 'legacy-oauth-state' },
          };
          return values[name];
        },
      },
    };

    assert.equal(auth.sessionCookieValue(request), 'legacy-session-token');
    assert.equal(auth.oauthStateCookieValue(request), 'legacy-oauth-state');

    const deletes = [];
    auth.clearAuthCookies({ cookies: { delete(name) { deletes.push(name); } } });
    assert.deepEqual(deletes, [
      auth.SESSION_COOKIE,
      auth.LEGACY_SESSION_COOKIE,
      auth.OAUTH_STATE_COOKIE,
      auth.LEGACY_OAUTH_STATE_COOKIE,
    ]);

    const canonicalRequest = {
      cookies: {
        get(name) {
          const values = {
            [auth.SESSION_COOKIE]: { value: 'canonical-session-token' },
            [auth.LEGACY_SESSION_COOKIE]: { value: 'legacy-session-token' },
            [auth.OAUTH_STATE_COOKIE]: { value: 'canonical-oauth-state' },
            [auth.LEGACY_OAUTH_STATE_COOKIE]: { value: 'legacy-oauth-state' },
          };
          return values[name];
        },
      },
    };

    assert.equal(auth.sessionCookieValue(canonicalRequest), 'canonical-session-token');
    assert.equal(auth.oauthStateCookieValue(canonicalRequest), 'canonical-oauth-state');
  } finally {
    cleanup();
  }
});
