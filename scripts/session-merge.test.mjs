import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), [
  'types.ts',
  'session-events.ts',
  'session-merge.ts',
]);
const require = createRequire(import.meta.url);
const { mergeSessionMessage, mergeSessionSnapshot, mergeSessionSummary, mergeSessionSummaryList, sessionSnapshotToSummary } = require(path.join(outDir, 'session-merge.js'));

afterAll(cleanup);

test('sessionSnapshotToSummary preserves session data and adds message_count', () => {
  const session = {
    id: 's1',
    title: 'Hello',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    runtime_id: 'runtime-1',
    continuation_strategy: 'full_transcript',
    status: 'idle',
    messages: [],
  };

  const summary = sessionSnapshotToSummary(session);
  assert.equal(summary.id, session.id);
  assert.equal(summary.message_count, 0);
  assert.equal(summary.title, session.title);
});

test('mergeSessionSnapshot returns the current snapshot when nothing changed', () => {
  const session = {
    id: 's1',
    title: 'Hello',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    runtime_id: 'runtime-1',
    continuation_strategy: 'full_transcript',
    status: 'idle',
    messages: [
      { id: 'm1', role: 'user', content: 'Hi', status: 'complete', created_at: '2026-01-01T00:00:00.000Z' },
    ],
  };

  const merged = mergeSessionSnapshot(session, { ...session, messages: [...session.messages] });
  assert.strictEqual(merged, session);
});

test('mergeSessionMessage updates an existing message and preserves unchanged state', () => {
  const session = {
    id: 's1',
    title: 'Hello',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    runtime_id: 'runtime-1',
    continuation_strategy: 'full_transcript',
    status: 'running',
    messages: [
      { id: 'm1', role: 'assistant', content: 'Part 1', status: 'streaming', created_at: '2026-01-01T00:00:00.000Z', metadata: { client_turn_id: 'turn-1' } },
    ],
  };

  const next = mergeSessionMessage(session, 's1', { id: 'm1', content: 'Part 2' });
  assert.notStrictEqual(next, session);
  assert.equal(next?.messages[0].content, 'Part 2');
  assert.equal(next?.messages[0].status, 'streaming');
  assert.deepEqual(next?.messages[0].metadata, { client_turn_id: 'turn-1' });
});

test('mergeSessionSummary and mergeSessionSummaryList update matching session summaries only', () => {
  const sessions = [
    {
      id: 's1',
      title: 'One',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      runtime_id: 'runtime-1',
      continuation_strategy: 'full_transcript',
      status: 'idle',
      message_count: 1,
    },
    {
      id: 's2',
      title: 'Two',
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      runtime_id: 'runtime-1',
      continuation_strategy: 'full_transcript',
      status: 'running',
      message_count: 2,
    },
  ];

  const merged = mergeSessionSummary(sessions[0], { id: 's1', title: 'Uno', message_count: 3, last_error: '' });
  assert.equal(merged?.title, 'Uno');
  assert.equal(merged?.message_count, 3);
  assert.equal(merged?.last_error, undefined);

  const listMerged = mergeSessionSummaryList(sessions, { id: 's2', status: 'idle', message_count: 7 });
  assert.equal(listMerged[0].title, 'One');
  assert.equal(listMerged[1].status, 'idle');
  assert.equal(listMerged[1].message_count, 7);
});

function afterAll(fn) {
  process.on('exit', fn);
}
