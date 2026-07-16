import { startMockHermes } from './mock-hermes.mjs';

async function assertOk(response, label) {
  if (!response.ok) throw new Error(`${label} ${response.status}: ${await response.text()}`);
  return response;
}

async function createSession(baseUrl, id) {
  const response = await assertOk(await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title: `Smoke ${id}` }),
  }), `create session ${id}`);
  return response.json();
}

async function startRun(baseUrl, sessionId, input) {
  const response = await assertOk(await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, model: 'hermes-agent', input: [{ role: 'user', content: input }] }),
  }), 'start run');
  return response.json();
}

async function readSse(baseUrl, runId, options = {}) {
  const response = await assertOk(await fetch(`${baseUrl}/v1/runs/${runId}/events`, { signal: options.signal }), `events ${runId}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let text = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.split(/\r?\n/).find((item) => item.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim());
      events.push(event);
      if (event.event === 'message.delta') text += event.delta;
      if (options.abortAfterFirstDelta && event.event === 'message.delta') {
        options.abortAfterFirstDelta();
        await reader.cancel().catch(() => undefined);
        return { events, text, aborted: true };
      }
    }
  }
  return { events, text, aborted: false };
}

async function main() {
  const mock = await startMockHermes({ port: 0, log: false, defaultDelayMs: 10, slowDelayMs: 120 });
  const baseUrl = mock.baseUrl;
  try {
    const health = await assertOk(await fetch(`${baseUrl}/health`), 'health').then((res) => res.json());
    if (health.version !== 'mock-hermes-stateful') throw new Error(`unexpected health version ${health.version}`);

    await createSession(baseUrl, 'mock-smoke');

    const defaultRun = await startRun(baseUrl, 'mock-smoke', 'hello');
    const defaultStream = await readSse(baseUrl, defaultRun.run_id);
    if (!defaultStream.text.includes('deterministic mock Hermes response')) throw new Error(`default stream mismatch: ${defaultStream.text}`);
    if (!defaultStream.events.some((event) => event.event === 'run.completed')) throw new Error('default stream did not complete');
    console.log('default_stream_ok', defaultStream.text);

    const slowRun = await startRun(baseUrl, 'mock-smoke', 'slow please');
    const controller = new AbortController();
    const slowStream = await readSse(baseUrl, slowRun.run_id, { signal: controller.signal, abortAfterFirstDelta: () => controller.abort() });
    if (!slowStream.aborted || slowStream.text.length === 0) throw new Error('slow stream was not aborted after first delta');
    console.log('slow_abort_ok', slowStream.text);

    const approvalRun = await startRun(baseUrl, 'mock-smoke', 'approval please');
    const approvalPromise = readSse(baseUrl, approvalRun.run_id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const approval = await assertOk(await fetch(`${baseUrl}/v1/runs/${approvalRun.run_id}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: 'once' }),
    }), 'approval').then((res) => res.json());
    if (approval.resolved !== 1) throw new Error('approval did not resolve');
    const approvalStream = await approvalPromise;
    if (!approvalStream.events.some((event) => event.event === 'approval.request')) throw new Error('approval request missing');
    if (!approvalStream.events.some((event) => event.event === 'approval.responded')) throw new Error('approval response missing');
    console.log('approval_ok', approval.choice, approvalStream.text);

    const rememberRun = await startRun(baseUrl, 'mock-smoke', 'remember local codecs are faster');
    await readSse(baseUrl, rememberRun.run_id);
    const recallRun = await startRun(baseUrl, 'mock-smoke', 'what do you remember');
    const recallStream = await readSse(baseUrl, recallRun.run_id);
    if (!recallStream.text.includes('local codecs are faster')) throw new Error(`memory recall mismatch: ${recallStream.text}`);
    console.log('memory_context_ok', recallStream.text);
  } finally {
    await mock.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
