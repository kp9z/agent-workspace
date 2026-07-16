import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), ['session-detail-prefetch.ts']);
const require = createRequire(import.meta.url);
const { shouldPrefetchSessionDetail, getSidebarSessionNavigation } = require(path.join(outDir, 'session-detail-prefetch.js'));

process.on('exit', cleanup);

test('shouldPrefetchSessionDetail only allows demand prefetch when the target is usable and uncached', () => {
  assert.equal(shouldPrefetchSessionDetail(null, { cached: false, prefetching: false }), false);
  assert.equal(shouldPrefetchSessionDetail('draft', { cached: false, prefetching: false, isDraft: true }), false);
  assert.equal(shouldPrefetchSessionDetail('cached', { cached: true, prefetching: false }), false);
  assert.equal(shouldPrefetchSessionDetail('busy', { cached: false, prefetching: true }), false);
  assert.equal(shouldPrefetchSessionDetail('fresh', { cached: false, prefetching: false }), true);
});

test('getSidebarSessionNavigation returns the active target and keyboard-neighbor lookahead', () => {
  assert.deepEqual(getSidebarSessionNavigation([], -1, 1), { sessionId: null, lookaheadSessionId: null });
  assert.deepEqual(getSidebarSessionNavigation(['a', 'b', 'c'], 1, 1), { sessionId: 'c', lookaheadSessionId: 'a' });
  assert.deepEqual(getSidebarSessionNavigation(['a', 'b', 'c'], 1, -1), { sessionId: 'a', lookaheadSessionId: 'c' });
  assert.deepEqual(getSidebarSessionNavigation(['a', 'b', 'c'], -1, 1), { sessionId: 'a', lookaheadSessionId: 'b' });
});
