import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import Database from 'better-sqlite3';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);

function createLegacyDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'kira-workspace.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    create table projects (
      id text primary key,
      name text not null,
      slug text not null unique,
      system_prompt text not null default '',
      created_at text not null,
      updated_at text not null
    );

    create table sessions (
      id text primary key,
      hermes_session_id text not null,
      project_id text references projects(id) on delete set null,
      title text not null,
      created_at text not null,
      updated_at text not null,
      runtime_id text not null default 'default',
      continuation_strategy text not null default 'full_transcript',
      status text not null,
      last_error text,
      pinned_at text,
      archived_at text
    );

    create table messages (
      id text primary key,
      session_id text not null references sessions(id) on delete cascade,
      role text not null,
      content text not null,
      status text not null,
      created_at text not null,
      metadata_json text,
      order_index integer not null,
      unique(session_id, order_index)
    );

    create table workspace_activity (
      id text primary key,
      last_interaction_at text not null,
      last_session_id text
    );

    create index idx_messages_session_order on messages(session_id, order_index);
  `);

  db.prepare('insert into workspace_activity (id, last_interaction_at, last_session_id) values (?, ?, ?)')
    .run('kenny', '2024-01-01T03:00:00.000Z', 'session-with-messages');

  db.prepare('insert into sessions (id, hermes_session_id, project_id, title, created_at, updated_at, runtime_id, continuation_strategy, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('session-empty-default', 'web_session-empty-default', null, 'New Kira session', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'default', 'full_transcript', 'idle');
  db.prepare('insert into sessions (id, hermes_session_id, project_id, title, created_at, updated_at, runtime_id, continuation_strategy, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('session-empty-custom', 'web_session-empty-custom', null, 'Custom queue', '2024-01-01T01:00:00.000Z', '2024-01-01T01:00:00.000Z', 'default', 'full_transcript', 'idle');
  db.prepare('insert into sessions (id, hermes_session_id, project_id, title, created_at, updated_at, runtime_id, continuation_strategy, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('session-with-messages', 'web_session-with-messages', null, 'Work session', '2024-01-01T02:00:00.000Z', '2024-01-01T02:30:00.000Z', 'default', 'full_transcript', 'idle');

  db.prepare('insert into messages (id, session_id, role, content, status, created_at, metadata_json, order_index) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('msg-1', 'session-with-messages', 'user', 'first', 'complete', '2024-01-01T02:10:00.000Z', null, 0);
  db.prepare('insert into messages (id, session_id, role, content, status, created_at, metadata_json, order_index) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('msg-2', 'session-with-messages', 'assistant', 'reply', 'complete', '2024-01-01T02:11:00.000Z', null, 1);
  db.prepare('insert into messages (id, session_id, role, content, status, created_at, metadata_json, order_index) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('msg-3', 'session-with-messages', 'user', 'second', 'complete', '2024-01-01T02:20:00.000Z', null, 2);

  db.close();
}

test('legacy database backfills session summary columns and drops redundant message index', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-session-summary-migration-'));
  process.env.HERMES_WEB_UI_DATA_DIR = dataDir;
  createLegacyDatabase(dataDir);

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
  const { getDb } = require(path.join(outDir, 'lib/db.js'));
  const { listSessions } = require(path.join(outDir, 'lib/store.js'));

  try {
    const db = getDb();
    const sessionRows = db.prepare('select id, message_count, last_user_message_at, sort_at from sessions order by id asc').all();
    assert.deepEqual(sessionRows, [
      {
        id: 'session-empty-custom',
        message_count: 0,
        last_user_message_at: null,
        sort_at: '2024-01-01T01:00:00.000Z',
      },
      {
        id: 'session-empty-default',
        message_count: 0,
        last_user_message_at: null,
        sort_at: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'session-with-messages',
        message_count: 3,
        last_user_message_at: '2024-01-01T02:20:00.000Z',
        sort_at: '2024-01-01T02:20:00.000Z',
      },
    ]);

    const indexNames = db.prepare('pragma index_list(messages)').all().map((row) => row.name);
    assert.equal(indexNames.includes('idx_messages_session_order'), false);
    const activity = db.prepare("select * from workspace_activity where id = 'agent-workspace'").get();
    assert.equal(activity.last_interaction_at, '2024-01-01T03:00:00.000Z');
    assert.equal(activity.last_session_id, 'session-with-messages');
    const sortIndex = db.prepare("select sql from sqlite_master where type = 'index' and name = 'idx_sessions_sort_at'").get();
    assert.match(sortIndex.sql, /title in \('New session', 'New Kira session'\)/);

    assert.throws(
      () => db.prepare('insert into messages (id, session_id, role, content, status, created_at, metadata_json, order_index) values (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('msg-dup', 'session-with-messages', 'user', 'dup', 'complete', '2024-01-01T02:30:00.000Z', null, 2),
      /UNIQUE|constraint/i,
    );

    const sessions = await listSessions();
    assert.deepEqual(sessions.map((session) => session.id), ['session-with-messages', 'session-empty-custom']);
    assert.deepEqual(sessions.map((session) => session.message_count), [3, 0]);
  } finally {
    cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
