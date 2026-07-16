import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);

function withMockClock(timestamps, run) {
  const RealDate = Date;
  let index = 0;
  class MockDate extends RealDate {
    constructor(value) {
      if (arguments.length === 0) {
        super(timestamps[Math.min(index, timestamps.length - 1)]);
        index += 1;
      } else {
        super(value);
      }
    }
    static now() {
      const stamp = timestamps[Math.min(index, timestamps.length - 1)];
      return new RealDate(stamp).getTime();
    }
  }
  Object.setPrototypeOf(MockDate, RealDate);
  MockDate.parse = RealDate.parse;
  MockDate.UTC = RealDate.UTC;
  globalThis.Date = MockDate;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.Date = RealDate;
    });
}

test('session summary counts and sort keys stay correct through turns, forks, and cleanup', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-session-summary-regression-'));
  process.env.HERMES_WEB_UI_DATA_DIR = dataDir;

  const { outDir, cleanup } = transpileTsFiles(rootDir, [
    'lib/db.ts',
    'lib/types.ts',
    'lib/session-events.ts',
    'lib/tool-events.ts',
    'lib/workspace-env.ts',
    'lib/server-perf.ts',
    'lib/attachments.ts',
    'lib/store.ts',
  ]);
  const tempNodeModules = path.join(outDir, 'node_modules');
  mkdirSync(tempNodeModules, { recursive: true });
  symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');

  const require = createRequire(import.meta.url);
  const { appendTurn, createPendingTurn, createProject, createSession, deleteProject, forkSession, listSessions, updateAssistantTurn } = require(path.join(outDir, 'lib/store.js'));
  const { getDb } = require(path.join(outDir, 'lib/db.js'));

  try {
    await withMockClock([
      '2024-01-01T00:00:00.000Z', // session A
      '2024-01-01T00:01:00.000Z', // session B
      '2024-01-01T00:10:00.000Z', // A pending turn
      '2024-01-01T00:11:00.000Z', // A assistant completion
      '2024-01-01T00:20:00.000Z', // A second completed turn
      '2024-01-01T00:30:00.000Z', // A fork
      '2024-01-01T00:40:00.000Z', // project + session C
      '2024-01-01T00:41:00.000Z', // project turn
    ], async () => {
      const sessionA = await createSession();
      const sessionB = await createSession();
      const pristineSessions = await listSessions();
      assert.equal(pristineSessions.length, 0);
      assert.equal(pristineSessions.some((session) => session.id === sessionA.id || session.id === sessionB.id), false);

      const firstTurn = await createPendingTurn(sessionA.id, 'first user turn', []);
      await updateAssistantTurn(sessionA.id, firstTurn.assistantMessage.id, { content: 'first assistant reply', status: 'complete' });

      await appendTurn(sessionA.id, 'second user turn', [], 'second assistant reply', []);
      const forked = await forkSession(sessionA.id, firstTurn.assistantMessage.id);

      const project = await createProject({ name: 'Cleanup project' });
      const projectSession = await createSession(project.id);
      await createPendingTurn(projectSession.id, 'project scoped turn', []);
      await deleteProject(project.id);

      const db = getDb();
      const sessionARow = db.prepare('select message_count, last_user_message_at, sort_at, updated_at from sessions where id = ?').get(sessionA.id);
      assert.deepEqual(sessionARow, {
        message_count: 4,
        last_user_message_at: '2024-01-01T00:20:00.000Z',
        sort_at: '2024-01-01T00:20:00.000Z',
        updated_at: '2024-01-01T00:20:00.000Z',
      });

      const forkedRow = db.prepare('select message_count, last_user_message_at, sort_at from sessions where id = ?').get(forked.id);
      assert.deepEqual(forkedRow, {
        message_count: 2,
        last_user_message_at: '2024-01-01T00:30:00.000Z',
        sort_at: '2024-01-01T00:30:00.000Z',
      });

      const sessions = await listSessions();
      assert.deepEqual(sessions.map((session) => session.id), [forked.id, sessionA.id]);
      assert.deepEqual(sessions.map((session) => session.message_count), [2, 4]);
      assert.equal(sessions.some((session) => session.id === projectSession.id), false);
      assert.equal(db.prepare('select count(*) as count from sessions where id = ?').get(projectSession.id).count, 0);
      assert.equal(db.prepare('select count(*) as count from messages where session_id = ?').get(projectSession.id).count, 0);
    });
  } finally {
    cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
