import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const appDir = process.cwd();
const port = process.env.PHASE1_SMOKE_PORT || '3111';
const base = `http://127.0.0.1:${port}`;

function isoFromNow(deltaMs = 0) {
  return new Date(Date.now() + deltaMs).toISOString();
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/runtime/health`);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for app server at ${url}: ${lastError}`);
}

function startServer(dataDir) {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: appDir,
    env: {
      ...process.env,
      HERMES_WEB_UI_DATA_DIR: dataDir,
      PORT: port,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  const cleanup = async () => {
    if (!child.killed) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    child.stdout.destroy();
    child.stderr.destroy();
  };

  return { child, cleanup };
}

function createRunningTurn(db, sessionId, startedAt) {
  const userId = randomUUID();
  const assistantId = randomUUID();
  db.transaction(() => {
    db.prepare(`
      insert into messages (id, session_id, role, content, status, created_at, metadata_json, order_index)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, sessionId, 'user', 'Trigger a running turn', 'complete', startedAt, null, 0);
    db.prepare(`
      insert into messages (id, session_id, role, content, status, created_at, metadata_json, order_index)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assistantId, sessionId, 'assistant', '', 'streaming', startedAt, JSON.stringify({ client_turn_id: 'phase1-regression' }), 1);
    db.prepare('update sessions set status = ?, updated_at = ?, last_error = null where id = ?').run('running', startedAt, sessionId);
  })();
  return { userId, assistantId };
}

function createStaleRunningTurn(db, sessionId, startedAt) {
  const ids = createRunningTurn(db, sessionId, startedAt);
  return ids;
}

async function createSession() {
  const response = await fetch(`${base}/api/sessions`, { method: 'POST' });
  const bodyText = await response.text();
  assert.ok(response.ok, `create session failed: ${response.status} ${bodyText}`);
  return JSON.parse(bodyText);
}

async function loadSession(id) {
  const response = await fetch(`${base}/api/sessions/${id}`);
  const bodyText = await response.text();
  return { response, session: JSON.parse(bodyText) };
}

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hermes-web-ui-phase1-'));
  const { cleanup } = startServer(dataDir);
  const db = new Database(path.join(dataDir, 'kira-workspace.sqlite'));

  try {
    await waitForHealth(base);

    const freshSession = await createSession();
    await loadSession(freshSession.id); // prewarm the route before exercising the race window.

    const freshStartedAt = isoFromNow();
    createRunningTurn(db, freshSession.id, freshStartedAt);
    const freshBefore = await loadSession(freshSession.id);
    assert.equal(freshBefore.response.status, 200, 'fresh running session should stay readable');
    assert.equal(freshBefore.session.status, 'running');
    assert.equal(freshBefore.session.last_error ?? null, null);
    assert.equal(freshBefore.session.messages.at(-1)?.status, 'streaming');
    const freshAfter = await loadSession(freshSession.id);
    assert.equal(freshAfter.session.status, 'running', 'fresh running session must not be failed by GET');
    assert.equal(freshAfter.session.last_error ?? null, null, 'fresh running session must not gain an error');
    assert.equal(freshAfter.session.messages.at(-1)?.status, 'streaming', 'fresh running assistant should remain streaming');

    const staleSession = await createSession();
    await loadSession(staleSession.id); // prewarm again so the stale check is the only work on the critical path.

    const staleStartedAt = isoFromNow(-10 * 60 * 1000);
    createStaleRunningTurn(db, staleSession.id, staleStartedAt);
    const staleResponse = await loadSession(staleSession.id);
    assert.equal(staleResponse.response.status, 200, 'stale running session should be reconciled, not 404');
    assert.equal(staleResponse.session.status, 'failed', 'stale running session should be marked failed');
    assert.match(staleResponse.session.last_error || '', /interrupted/i);
    assert.equal(staleResponse.session.messages.at(-1)?.status, 'failed', 'stale assistant turn should be failed in storage');
    assert.match(staleResponse.session.messages.at(-1)?.content || '', /interrupted/i);

    console.log('phase1-running-turn-regression: ok');
  } finally {
    db.close();
    await cleanup().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
