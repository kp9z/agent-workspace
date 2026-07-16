import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-steer-stale-'));
process.env.HERMES_WEB_UI_DATA_DIR = dataDir;

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(rootDir, [
  'lib/db.ts',
  'lib/types.ts',
  'lib/session-events.ts',
  'lib/tool-events.ts',
  'lib/workspace-env.ts',
  'lib/server-perf.ts',
  'lib/attachments.ts',
  'lib/store.ts',
  'lib/run-registry.ts',
  'lib/hermes.ts',
  'lib/request-body.ts',
  'app/api/sessions/[id]/steer/route.ts',
]);
const tempNodeModules = path.join(outDir, 'node_modules');
mkdirSync(tempNodeModules, { recursive: true });
symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');
const aliasRoot = path.join(tempNodeModules, '@');
mkdirSync(aliasRoot, { recursive: true });
symlinkSync(path.join(outDir, 'lib'), path.join(aliasRoot, 'lib'), 'dir');

const require = createRequire(import.meta.url);
const { createPendingTurn, createSession, getSession } = require(path.join(outDir, 'lib/store.js'));
const { runningTurns } = require(path.join(outDir, 'lib/run-registry.js'));
const { HermesHttpError } = require(path.join(outDir, 'lib/hermes.js'));
const { POST } = require(path.join(outDir, 'app/api/sessions/[id]/steer/route.js'));

process.on('exit', cleanup);

test('steer 404 reconciles stale runs cleanly', async () => {
  const originalFetch = global.fetch;
  let session;
  try {
    session = await createSession();
    const pending = await createPendingTurn(session.id, 'steer this turn', []);
    runningTurns.set(session.id, {
      promise: Promise.resolve(),
      started_at: new Date().toISOString(),
      assistant_message_id: pending.assistantMessage.id,
      hermes_run_id: 'run-stale-404',
      controller: new AbortController(),
    });

    global.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/v1/runs/run-stale-404/steer')) {
        return new Response('missing run', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const response = await POST(new Request('http://127.0.0.1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'please adjust' }),
    }), {
      params: Promise.resolve({ id: session.id }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, 'stale_run');
    assert.match(body.error || '', /stale|missing/i);

    const reconciled = await getSession(session.id);
    assert.ok(reconciled);
    assert.equal(reconciled.status, 'failed');
    assert.match(reconciled.last_error || '', /no longer available/i);
    assert.equal(reconciled.messages.at(-1)?.status, 'failed');
  } finally {
    global.fetch = originalFetch;
    runningTurns.delete(session.id);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
