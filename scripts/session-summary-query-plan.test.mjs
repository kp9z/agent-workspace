import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);

test('listSessions uses the denormalized sort index and avoids message scans or temp b-trees', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-session-summary-plan-'));
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
  const { createPendingTurn, createSession, listSessions, LIST_SESSIONS_SQL } = require(path.join(outDir, 'lib/store.js'));
  const { getDb } = require(path.join(outDir, 'lib/db.js'));

  try {
    const activeSession = await createSession();
    await createPendingTurn(activeSession.id, 'query plan turn', []);
    await createSession();
    await listSessions();

    const db = getDb();
    const planRows = db.prepare(`explain query plan ${LIST_SESSIONS_SQL}`).all();
    const details = planRows.map((row) => row.detail);

    assert.ok(details.some((detail) => /idx_sessions_sort_at/i.test(detail)), `expected plan to use idx_sessions_sort_at, got: ${details.join(' | ')}`);
    assert.equal(details.some((detail) => /messages/i.test(detail)), false, `expected plan to avoid messages, got: ${details.join(' | ')}`);
    assert.equal(details.some((detail) => /temp b-tree/i.test(detail)), false, `expected plan to avoid temp b-tree, got: ${details.join(' | ')}`);
    assert.equal(details.some((detail) => /group by/i.test(detail)), false, `expected plan to avoid grouping, got: ${details.join(' | ')}`);
  } finally {
    cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
