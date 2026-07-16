import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function loadSmokeModule() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/smoke.ts']);
  const modulePath = path.join(outDir, 'lib/smoke.js');
  delete require.cache[modulePath];
  const smoke = require(modulePath);
  return { smoke, cleanup };
}

test('smoke helper accepts canonical and legacy headers', () => {
  const { smoke, cleanup } = loadSmokeModule();
  try {
    assert.equal(smoke.isSmokeTestRequest({ get: (name) => (name === smoke.AGENT_WORKSPACE_SMOKE_HEADER ? '1' : null) }), true);
    assert.equal(smoke.isSmokeTestRequest({ get: (name) => (name === smoke.LEGACY_SMOKE_HEADER ? '1' : null) }), true);
    assert.equal(smoke.isSmokeTestRequest({ get: () => null }), false);
  } finally {
    cleanup();
  }
});
