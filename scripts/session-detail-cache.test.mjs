import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), ['session-detail-cache.ts']);
const require = createRequire(import.meta.url);
const { SessionDetailCache } = require(path.join(outDir, 'session-detail-cache.js'));

process.on('exit', cleanup);

test('SessionDetailCache evicts the least-recently-used entry and refreshes touched entries', () => {
  const cache = new SessionDetailCache(2);
  cache.set({ id: 'a' });
  cache.set({ id: 'b' });

  assert.deepEqual(cache.ids(), ['a', 'b']);
  assert.equal(cache.get('a')?.id, 'a');
  assert.deepEqual(cache.ids(), ['b', 'a']);

  cache.set({ id: 'c' });
  assert.deepEqual(cache.ids(), ['a', 'c']);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.get('b'), undefined);
});

test('SessionDetailCache prune keeps visible entries and still enforces the size cap', () => {
  const cache = new SessionDetailCache(2);
  cache.set({ id: 'a' });
  cache.set({ id: 'b' });
  cache.set({ id: 'c' });

  cache.prune(new Set(['b', 'c', 'd']));
  assert.deepEqual(cache.ids(), ['b', 'c']);
});
