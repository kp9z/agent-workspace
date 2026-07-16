import http from 'node:http';
import { randomUUID } from 'node:crypto';

const DEFAULT_PORT = Number(process.env.MOCK_HERMES_PORT || 8642);
const DEFAULT_DELAY_MS = Number(process.env.MOCK_HERMES_DEFAULT_DELAY_MS || 80);
const SLOW_DELAY_MS = Number(process.env.MOCK_HERMES_SLOW_DELAY_MS || 900);

function now() {
  return new Date().toISOString();
}

function log(enabled, ...args) {
  if (enabled) console.log('[mock-hermes]', ...args);
}

async function readJson(request) {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sessionResponse(session) {
  return {
    object: 'hermes.session',
    id: session.id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    messages: session.messages,
    memory: session.memory,
    session,
  };
}

function makeMessage(role, content) {
  return { id: `msg_${randomUUID()}`, role, content, created_at: now() };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part) => {
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'image_url') return '[image]';
    return '';
  }).filter(Boolean).join(' ');
}

function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part?.type === 'image_url' && part?.image_url?.url).length;
}

function latestUserInput(input) {
  if (Array.isArray(input)) {
    const lastUser = [...input].reverse().find((message) => message?.role === 'user');
    return { content: lastUser?.content ?? '', text: textFromContent(lastUser?.content ?? '') };
  }
  return { content: input, text: textFromContent(input) };
}

function scenarioFor(prompt, forcedScenario) {
  const configured = forcedScenario || process.env.MOCK_HERMES_SCENARIO || '';
  if (configured) return configured;
  const lower = prompt.toLowerCase();
  if (lower.includes('approval')) return 'approval';
  if (lower.includes('error')) return 'error';
  if (lower.includes('tool')) return 'tool';
  if (lower.includes('slow')) return 'slow';
  return 'default';
}

function responseFor(run, session) {
  const prompt = run.promptText;
  const lower = prompt.toLowerCase();
  const imageCount = run.imageCount;
  const rememberMatch = prompt.match(/remember\s+(.+)/i);
  if (rememberMatch) {
    const memory = rememberMatch[1].trim();
    if (memory) {
      session.memory.push(memory);
      return `I will remember: ${memory}`;
    }
  }
  if (/what do you remember/i.test(lower)) {
    return session.memory.length ? `I remember: ${session.memory.join('; ')}` : 'I do not remember anything yet.';
  }
  if (imageCount > 0) return `I received ${imageCount} image${imageCount === 1 ? '' : 's'}.`;
  if (/repeat that exact string/i.test(lower) && session.messages.some((message) => String(message.content).includes('Ubuntu 24.04.3 LTS'))) {
    return 'Ubuntu 24.04.3 LTS';
  }
  if (/pretty_name|os-release|ubuntu/i.test(lower)) return 'Ubuntu 24.04.3 LTS';
  if (run.scenario === 'approval') return 'Approval resolved; continuing deterministic mock response.';
  if (run.scenario === 'tool') return 'Tool work finished and the deterministic assistant response is ready.';
  if (run.scenario === 'slow') return 'This is a slow deterministic mock response streaming in several chunks for stop testing.';
  return 'This is a deterministic mock Hermes response.';
}

function chunkText(text, size = 14) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamChunks(response, run, text, delayMs) {
  for (const delta of chunkText(text, run.scenario === 'slow' ? 10 : 18)) {
    if (run.aborted || response.destroyed || response.writableEnded) return false;
    sse(response, { event: 'message.delta', run_id: run.id, delta });
    const ok = await wait(delayMs, run.abortSignal);
    if (!ok) return false;
  }
  return true;
}

export async function startMockHermes(options = {}) {
  const sessions = new Map();
  const runs = new Map();
  const runRequests = [];
  const logEnabled = options.log ?? process.env.MOCK_HERMES_LOG !== '0';
  const defaultDelayMs = Number(options.defaultDelayMs ?? DEFAULT_DELAY_MS);
  const slowDelayMs = Number(options.slowDelayMs ?? SLOW_DELAY_MS);

  function getOrCreateSession(id, title = 'Mock Hermes session') {
    const sessionId = id || `mock_session_${sessions.size + 1}`;
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const session = { id: sessionId, title, created_at: now(), updated_at: now(), messages: [], memory: [] };
    sessions.set(sessionId, session);
    log(logEnabled, 'session created', sessionId);
    return session;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { version: 'mock-hermes-stateful' });
      }

      if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
        return sendJson(response, 200, {
          run_submission: true,
          features: { runs_session_history: true },
          run_events_sse: true,
          run_approval_response: true,
          run_steer: true,
          session_resources: true,
        });
      }

      const sessionMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && sessionMessagesMatch) {
        const id = decodeURIComponent(sessionMessagesMatch[1]);
        const session = sessions.get(id);
        if (!session) return sendJson(response, 404, { error: { code: 'session_not_found', message: `Session ${id} not found` } });
        return sendJson(response, 200, { object: 'list', session_id: id, data: session.messages });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
        const session = sessions.get(id);
        if (!session) return sendJson(response, 404, { error: { code: 'session_not_found', message: `Session ${id} not found` } });
        return sendJson(response, 200, sessionResponse(session));
      }

      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJson(request).catch(() => ({}));
        const title = body.title || 'Mock Hermes session';
        const sessionId = body.id || `mock_session_${sessions.size + 1}`;
        const titleOwner = Array.from(sessions.values()).find((session) => session.title === title);
        if (titleOwner && titleOwner.id !== sessionId) {
          return sendJson(response, 400, { error: { code: 'duplicate_title', message: `Title '${title}' is already in use by session ${titleOwner.id}` } });
        }
        const session = getOrCreateSession(sessionId, title);
        return sendJson(response, 201, sessionResponse(session));
      }

      if (request.method === 'PATCH' && url.pathname.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
        const session = sessions.get(id);
        if (!session) return sendJson(response, 404, { error: { code: 'session_not_found', message: `Session ${id} not found` } });
        const body = await readJson(request).catch(() => ({}));
        if (typeof body.title === 'string') {
          session.title = body.title;
          session.updated_at = now();
        }
        return sendJson(response, 200, { ok: true, title: session.title, session });
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(request).catch(() => ({}));
        const prompt = JSON.stringify(body.messages || []);
        let title = '💬 Mock title generated';
        if (/docker|container|rebuild/i.test(prompt)) title = '🐳 Rebuild Docker container';
        if (/github|commit|push/i.test(prompt)) title = '💻 GitHub commit push';
        return sendJson(response, 200, {
          id: `chatcmpl_${Date.now()}`,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: title }, finish_reason: 'stop' }],
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const body = await readJson(request);
        runRequests.push(body);
        const session = getOrCreateSession(body.session_id);
        const { content, text } = latestUserInput(body.input);
        const imageCount = countImages(content);
        const forcedScenario = url.searchParams.get('scenario');
        const scenario = scenarioFor(text, forcedScenario);
        const run = {
          id: `run_${runs.size + 1}`,
          session_id: session.id,
          status: 'started',
          scenario,
          input: body.input,
          model: body.model,
          promptText: text,
          imageCount,
          created_at: now(),
          approval: null,
          approvalWaiter: null,
          steers: [],
          aborted: false,
          abortSignal: null,
        };
        runs.set(run.id, run);
        session.messages.push(makeMessage('user', content));
        session.updated_at = now();
        log(logEnabled, 'run started', run.id, 'session', session.id, 'scenario', scenario);
        return sendJson(response, 202, { run_id: run.id, status: 'started' });
      }

      const eventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventsMatch) {
        const run = runs.get(decodeURIComponent(eventsMatch[1]));
        if (!run) return sendJson(response, 404, { error: { code: 'run_not_found' } });
        const abortController = new AbortController();
        run.abortSignal = abortController.signal;
        request.on('close', () => {
          if (!response.writableEnded) {
            run.aborted = true;
            abortController.abort();
            log(logEnabled, 'stream aborted', run.id);
          }
        });
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });

        const session = sessions.get(run.session_id);
        if (run.scenario === 'tool') {
          sse(response, { event: 'tool.started', run_id: run.id, tool: 'mock_search', summary: 'Starting deterministic mock tool' });
          await wait(defaultDelayMs, run.abortSignal);
          sse(response, { event: 'tool.running', run_id: run.id, tool: 'mock_search', summary: 'Checking local mock state', output: '2 mock records scanned' });
          await wait(defaultDelayMs, run.abortSignal);
          sse(response, { event: 'tool.completed', run_id: run.id, tool: 'mock_search', summary: 'Mock tool completed', output: 'result=ok' });
        }

        if (run.scenario === 'approval') {
          run.approvalWaiter = createDeferred();
          sse(response, { event: 'approval.request', run_id: run.id, command: 'mock-hermes requires approval', summary: 'Approve deterministic mock action?' });
          await run.approvalWaiter.promise;
          if (run.aborted || response.destroyed || response.writableEnded) return;
          sse(response, { event: 'approval.responded', run_id: run.id, choice: run.approval?.choice || 'once', resolved: 1 });
          if (run.approval?.choice === 'deny') {
            await streamChunks(response, run, 'Denied. I will not run the mock action.', defaultDelayMs);
            sse(response, { event: 'run.completed', run_id: run.id, output: '' });
            response.end();
            return;
          }
        }

        if (run.scenario === 'error') {
          sse(response, { event: 'message.delta', run_id: run.id, delta: 'Partial response before failure. ' });
          await wait(defaultDelayMs, run.abortSignal);
          if (!run.aborted && !response.destroyed && !response.writableEnded) {
            run.status = 'failed';
            sse(response, { event: 'run.failed', run_id: run.id, error: 'Deterministic mock failure' });
            response.end();
          }
          return;
        }

        const text = responseFor(run, session);
        const completed = await streamChunks(response, run, text, run.scenario === 'slow' ? slowDelayMs : defaultDelayMs);
        if (!completed || run.aborted || response.destroyed || response.writableEnded) return;
        run.status = 'completed';
        session.messages.push(makeMessage('assistant', text));
        session.updated_at = now();
        sse(response, { event: 'run.completed', run_id: run.id, output: '' });
        response.end();
        return;
      }

      const approvalMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/approval$/);
      if (request.method === 'POST' && approvalMatch) {
        const runId = decodeURIComponent(approvalMatch[1]);
        const run = runs.get(runId);
        const body = await readJson(request).catch(() => ({}));
        const choice = ['once', 'session', 'always', 'deny'].includes(body.choice) ? body.choice : 'once';
        if (run && run.approvalWaiter && !run.approval) {
          run.approval = { choice, resolved_at: now() };
          run.approvalWaiter.resolve();
        } else if (run) {
          log(logEnabled, 'approval rejected', runId, choice, '(no active approval session)');
          return sendJson(response, 409, { error: { message: `Run has no active approval session: ${runId}`, type: 'invalid_request_error', param: null, code: 'approval_not_active' } });
        } else {
          log(logEnabled, 'approval rejected', runId, choice, '(run not found)');
          return sendJson(response, 404, { error: { code: 'run_not_found' } });
        }
        log(logEnabled, 'approval received', runId, choice);
        return sendJson(response, 200, { object: 'hermes.run.approval_response', run_id: runId, choice, resolved: 1 });
      }

      const steerMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/steer$/);
      if (request.method === 'POST' && steerMatch) {
        const runId = decodeURIComponent(steerMatch[1]);
        const run = runs.get(runId);
        if (!run) return sendJson(response, 404, { error: { code: 'run_not_found' } });
        const body = await readJson(request).catch(() => ({}));
        const input = String(body.input || body.content || '').trim();
        if (!input) return sendJson(response, 400, { error: { code: 'empty_steer' } });
        run.steers.push({ input, created_at: now() });
        log(logEnabled, 'steer received', runId, input.slice(0, 80));
        return sendJson(response, 200, { object: 'hermes.run.steer', run_id: runId, accepted: true });
      }

      return sendJson(response, 404, { error: { code: 'not_found', path: url.pathname } });
    } catch (error) {
      return sendJson(response, 500, { error: { code: 'mock_error', message: error instanceof Error ? error.message : String(error) } });
    }
  });

  const port = Number(options.port ?? DEFAULT_PORT);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start mock Hermes server');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  log(logEnabled, `listening ${baseUrl}`);

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
  };

  return { baseUrl, sessions, runs, runRequests, shutdown };
}

async function main() {
  const mock = await startMockHermes({ port: DEFAULT_PORT, log: true });
  const shutdown = async () => {
    console.log('\n[mock-hermes] shutting down');
    await mock.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
