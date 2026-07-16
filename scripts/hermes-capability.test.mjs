import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function loadHermes(project = null) {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/hermes.ts', 'lib/tool-events.ts', 'lib/workspace-env.ts']);
  mkdirSync(path.join(outDir, 'lib'), { recursive: true });
  globalThis.__agentWorkspaceTestProject = project;
  writeFileSync(path.join(outDir, 'lib/store.js'), "exports.getProject = async () => globalThis.__agentWorkspaceTestProject;\n");
  const modulePath = path.join(outDir, 'lib/hermes.js');
  delete require.cache[modulePath];
  const hermes = require(modulePath);
  return {
    hermes,
    cleanup() {
      delete globalThis.__agentWorkspaceTestProject;
      cleanup();
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session(overrides = {}) {
  return {
    id: 'session-1',
    title: 'Continuity',
    project_id: null,
    hermes_session_id: null,
    continuation_strategy: 'full_transcript',
    messages: [],
    ...overrides,
  };
}

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

test('capability enforcement accepts required flag, shares successful probes, and retries transient failures', async () => {
  const originalFetch = globalThis.fetch;
  const { hermes, cleanup } = loadHermes();
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return json({ features: { runs_session_history: true } });
    };
    hermes.resetHermesCapabilityCacheForTests();
    const [first, second] = await Promise.all([
      hermes.requirePersistentRunsSessionHistory(),
      hermes.requirePersistentRunsSessionHistory(),
    ]);
    assert.deepEqual(first, { features: { runs_session_history: true } });
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    await hermes.requirePersistentRunsSessionHistory();
    assert.equal(calls, 1);

    let attempt = 0;
    hermes.resetHermesCapabilityCacheForTests();
    globalThis.fetch = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('temporary outage');
      return json({ features: { runs_session_history: true } });
    };
    await assert.rejects(
      hermes.requirePersistentRunsSessionHistory(),
      (error) => error instanceof hermes.HermesCapabilityError && error.kind === 'unavailable' && !error.message.includes('temporary outage'),
    );
    await hermes.requirePersistentRunsSessionHistory();
    assert.equal(attempt, 2);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test('an already-aborted capability request does not start or warm a probe', async () => {
  const originalFetch = globalThis.fetch;
  const { hermes, cleanup } = loadHermes();
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return json({ features: { runs_session_history: true } });
    };
    hermes.resetHermesCapabilityCacheForTests();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      hermes.requirePersistentRunsSessionHistory(controller.signal),
      (error) => error instanceof hermes.HermesCapabilityError && error.kind === 'unavailable',
    );
    assert.equal(calls, 0);
    await hermes.requirePersistentRunsSessionHistory();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test('missing, false, malformed, and non-2xx capability responses fail with the public incompatibility message', async () => {
  const originalFetch = globalThis.fetch;
  const { hermes, cleanup } = loadHermes();
  const cases = [
    () => json({ features: {} }),
    () => json({ features: { runs_session_history: false } }),
    () => new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => json({ error: 'missing' }, 404),
  ];
  try {
    for (const makeResponse of cases) {
      hermes.resetHermesCapabilityCacheForTests();
      globalThis.fetch = async () => makeResponse();
      await assert.rejects(
        hermes.requirePersistentRunsSessionHistory(),
        (error) => error instanceof hermes.HermesCapabilityError
          && error.kind === 'incompatible'
          && error.message === hermes.HERMES_RUNS_SESSION_HISTORY_INCOMPATIBLE_MESSAGE,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test('runtime health is incompatible and streaming stops before session APIs when capability is absent', async () => {
  const originalFetch = globalThis.fetch;
  const { hermes, cleanup } = loadHermes();
  const urls = [];
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/health')) return json({ version: 'test' });
      if (url.endsWith('/v1/capabilities')) return json({ features: {} });
      throw new Error(`unexpected fetch ${url}`);
    };
    hermes.resetHermesCapabilityCacheForTests();
    const health = await hermes.runtimeHealth();
    assert.equal(health.status, 'error');
    assert.equal(health.error, hermes.HERMES_RUNS_SESSION_HISTORY_INCOMPATIBLE_MESSAGE);
    const healthRouteSource = readFileSync(path.join(rootDir, 'app/api/runtime/health/route.ts'), 'utf8');
    assert.match(healthRouteSource, /status: info\.status === 'ok' \? 200 : 503/);

    urls.length = 0;
    hermes.resetHermesCapabilityCacheForTests();
    await assert.rejects(
      collect(hermes.streamHermesTurn(session(), 'hello')),
      (error) => error instanceof hermes.HermesCapabilityError && error.kind === 'incompatible',
    );
    assert.equal(urls.length, 1);
    assert.equal(urls[0].endsWith('/v1/capabilities'), true);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test('two turns send only current input with one stable session id and preserve upstream canonical continuity', async () => {
  const originalFetch = globalThis.fetch;
  const project = { id: 'project-1', system_prompt: 'Project-specific instructions.' };
  const { hermes, cleanup } = loadHermes(project);
  const createdSessions = new Set();
  const runs = [];
  const upstreamHistory = new Map();
  let runNumber = 0;
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/capabilities') return json({ features: { runs_session_history: true } });
      if (/^\/api\/sessions\/[^/]+$/.test(url.pathname) && (!init.method || init.method === 'GET')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        return createdSessions.has(id) ? json({ id }) : json({ error: 'not found' }, 404);
      }
      if (url.pathname === '/api/sessions' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        createdSessions.add(body.id);
        return json(body, 201);
      }
      if (url.pathname === '/v1/runs' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        runs.push(body);
        const history = upstreamHistory.get(body.session_id) || [];
        const answer = body.input === 'What number?' && history.includes('Remember 7431.') ? '7431' : 'OK';
        history.push(body.input, answer);
        upstreamHistory.set(body.session_id, history);
        runNumber += 1;
        return json({ run_id: `run-${runNumber}` });
      }
      if (/^\/v1\/runs\/run-\d+\/events$/.test(url.pathname)) {
        const answer = url.pathname.includes('run-2') ? '7431' : 'OK';
        const sse = `data: ${JSON.stringify({ event: 'message.delta', delta: answer })}\n\ndata: ${JSON.stringify({ event: 'run.completed' })}\n\n`;
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    hermes.resetHermesCapabilityCacheForTests();
    const chat = session({ id: 'stable-1', project_id: 'project-1' });
    const firstEvents = await collect(hermes.streamHermesTurn(chat, 'Remember 7431.'));
    const secondEvents = await collect(hermes.streamHermesTurn(chat, 'What number?'));

    assert.equal(firstEvents.some((event) => event.type === 'assistant_delta' && event.text === 'OK'), true);
    assert.equal(secondEvents.some((event) => event.type === 'assistant_delta' && event.text.includes('7431')), true);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((run) => run.session_id), ['web_stable-1', 'web_stable-1']);
    assert.deepEqual(runs.map((run) => run.input), ['Remember 7431.', 'What number?']);
    assert.equal(runs.every((run) => typeof run.input === 'string'), true);
    assert.equal(runs.every((run) => run.instructions.includes('Project-specific instructions.')), true);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test('a compatible runtime keeps attachment input multimodal for the current turn only', async () => {
  const originalFetch = globalThis.fetch;
  const { hermes, cleanup } = loadHermes();
  let runBody;
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/capabilities') return json({ features: { runs_session_history: true } });
      if (url.pathname === '/api/sessions/web_image-session') return json({ id: 'web_image-session' });
      if (url.pathname === '/v1/runs') {
        runBody = JSON.parse(String(init.body));
        return json({ run_id: 'run-image' });
      }
      if (url.pathname === '/v1/runs/run-image/events') return new Response('data: [DONE]\n\n', { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    };
    hermes.resetHermesCapabilityCacheForTests();
    await collect(hermes.streamHermesTurn(session({ id: 'image-session' }), 'look', [{
      id: 'a', name: 'a.png', mime_type: 'image/png', size_bytes: 8, data_url: 'data:image/png;base64,AAAA',
    }]));
    assert.deepEqual(runBody.input, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);

    await collect(hermes.streamHermesTurn(session({ id: 'image-session' }), '/clear', [{
      id: 'b', name: 'private.png', mime_type: 'image/png', size_bytes: 8, data_url: 'data:image/png;base64,PRIVATE',
    }]));
    assert.equal(typeof runBody.input, 'string');
    assert.match(runBody.input, /^Create a compact context capsule/);
    assert.equal(runBody.input.includes('PRIVATE'), false);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});
