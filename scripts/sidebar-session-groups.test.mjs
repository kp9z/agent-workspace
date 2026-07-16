import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), ['sidebar-session-groups.ts']);
const require = createRequire(import.meta.url);
const { groupProjectSessions, buildPinnedSessionNumbers, sortSessionsByPinnedNumber } = require(path.join(outDir, 'sidebar-session-groups.js'));

process.on('exit', cleanup);

test('groupProjectSessions preserves insertion order per project', () => {
  const sessions = [
    { id: 'top-1', project_id: null },
    { id: 'p-1', project_id: 'project-a' },
    { id: 'p-2', project_id: 'project-a' },
    { id: 'p-3', project_id: 'project-b' },
    { id: 'p-4', project_id: 'project-a' },
  ];

  const grouped = groupProjectSessions(sessions);
  assert.deepEqual([...grouped.keys()], ['project-a', 'project-b']);
  assert.deepEqual(grouped.get('project-a')?.map((session) => session.id), ['p-1', 'p-2', 'p-4']);
  assert.deepEqual(grouped.get('project-b')?.map((session) => session.id), ['p-3']);
});

test('buildPinnedSessionNumbers and sortSessionsByPinnedNumber keep pinned chats numbered and ordered first', () => {
  const pinnedSessions = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
  const pinnedSessionNumbers = buildPinnedSessionNumbers(pinnedSessions);
  assert.deepEqual([...pinnedSessionNumbers.entries()], [['first', 1], ['second', 2], ['third', 3]]);

  const sessions = [{ id: 'second' }, { id: 'unpinned' }, { id: 'first' }, { id: 'third' }];
  sortSessionsByPinnedNumber(sessions, pinnedSessionNumbers);
  assert.deepEqual(sessions.map((session) => session.id), ['first', 'second', 'third', 'unpinned']);
});
