import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startMockHermes } from './mock-hermes.mjs';

const appDir = process.cwd();
const externalBase = process.env.SMOKE_BASE_URL;
const smokePort = process.env.SMOKE_PORT || '3110';
const smokeStartScript = process.env.SMOKE_START_SCRIPT || 'dev';
const needsMockHermes = !externalBase;
const startsOwnServer = !externalBase;
const base = externalBase || `http://127.0.0.1:${smokePort}`;
const smokeDataDir = process.env.SMOKE_DATA_DIR;

function normalize(text) {
  return text.toLowerCase().replace(/["'`.,;:!?]/g, '').replace(/\s+/g, ' ').trim();
}

async function readNdjsonResponse(response) {
  if (!response.ok || !response.body) {
    throw new Error(`message ${response.status}: ${await response.text()}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistant = '';
  let toolEvents = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'assistant_delta') assistant += event.text;
      if (event.type === 'tool_call' || event.type === 'tool_output') toolEvents += 1;
      if (event.type === 'error') throw new Error(event.message);
    }
  }
  return { assistant, toolEvents };
}

const smokeMessageHeaders = { 'Content-Type': 'application/json', 'X-Agent-Workspace-Smoke-Test': '1' };

function smokeBody(body) {
  return JSON.stringify({ ...body, suppress_notifications: true });
}

async function readTurnResponse(response, sessionId) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/x-ndjson') || contentType.includes('text/event-stream')) {
    return readNdjsonResponse(response);
  }
  if (!response.ok) throw new Error(`message ${response.status}: ${await response.text()}`);
  const accepted = await response.json();
  const assistantId = accepted.assistant_message?.id;
  if (!assistantId) throw new Error('message response did not include an assistant_message id');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const sessionResponse = await fetch(`${base}/api/sessions/${sessionId}`);
    if (!sessionResponse.ok) throw new Error(`poll session ${sessionId} ${sessionResponse.status}`);
    const session = await sessionResponse.json();
    const assistantMessage = Array.isArray(session.messages)
      ? session.messages.find((message) => message.id === assistantId)
      : null;
    if (assistantMessage?.status === 'failed') throw new Error(assistantMessage.error || assistantMessage.content || 'assistant turn failed');
    if (assistantMessage?.status === 'complete') {
      return { assistant: assistantMessage.content || '', toolEvents: (assistantMessage.tool_events || []).length };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for assistant turn ${assistantId}`);
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

async function startServer(hermesBaseUrl) {
  const dataDir = smokeDataDir || (await mkdtemp(path.join(os.tmpdir(), 'hermes-web-ui-smoke-')));
  const child = spawn('npm', ['run', smokeStartScript], {
    cwd: appDir,
    env: {
      ...process.env,
      HERMES_BASE_URL: hermesBaseUrl,
      HERMES_WEB_UI_DATA_DIR: dataDir,
      PORT: smokePort,
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
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
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
    if (!smokeDataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  const shutdown = async () => {
    await cleanup().catch(() => undefined);
  };

  const signalHandler = async () => {
    await shutdown();
    process.exit(130);
  };

  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);
  process.once('exit', () => {
    if (!child.killed) child.kill('SIGTERM');
  });

  try {
    await waitForHealth(base);
    return { shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

async function main() {
  const mockHermes = needsMockHermes ? await startMockHermes({ port: 0, log: false }) : null;
  const server = startsOwnServer ? await startServer(mockHermes?.baseUrl || base) : null;

  try {
    const health = await fetch(`${base}/api/runtime/health`);
    const healthBody = await health.json();
    console.log('runtime', health.status, healthBody.status, healthBody.version || healthBody.error || '');
    if (!health.ok) throw new Error(`runtime health ${health.status}`);

    const createdA = await fetch(`${base}/api/sessions`, { method: 'POST' });
    if (!createdA.ok) throw new Error(`create session A ${createdA.status}`);
    const sessionA = await createdA.json();
    console.log('session_a', sessionA.id);

    const renameResponse = await fetch(`${base}/api/sessions/${sessionA.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke session A' }),
    });
    if (!renameResponse.ok) throw new Error(`rename session A ${renameResponse.status}`);
    const renamedA = await renameResponse.json();
    console.log('renamed_session_a', renamedA.title);
    if (renamedA.title !== 'Smoke session A') throw new Error(`rename path did not persist title: ${renamedA.title}`);

    const createdB = await fetch(`${base}/api/sessions`, { method: 'POST' });
    if (!createdB.ok) throw new Error(`create session B ${createdB.status}`);
    const sessionB = await createdB.json();
    console.log('session_b', sessionB.id);

    if (mockHermes) {
      const projectResponse = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Smoke Project', system_prompt: 'Project smoke system prompt' }),
      });
      if (!projectResponse.ok) throw new Error(`create project ${projectResponse.status}`);
      const project = await projectResponse.json();
      const projectEditResponse = await fetch(`${base}/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Smoke Project Edited', system_prompt: 'Project smoke system prompt edited' }),
      });
      if (!projectEditResponse.ok) throw new Error(`edit project ${projectEditResponse.status}`);
      const editedProject = await projectEditResponse.json();
      if (editedProject.slug !== 'smoke-project-edited' || editedProject.system_prompt !== 'Project smoke system prompt edited') {
        throw new Error(`project edit did not persist: ${JSON.stringify(editedProject)}`);
      }
      const projectSessionResponse = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: project.id }),
      });
      if (!projectSessionResponse.ok) throw new Error(`create project session ${projectSessionResponse.status}`);
      const projectSession = await projectSessionResponse.json();
      if (projectSession.project_id !== project.id) throw new Error('project_id was not persisted on session');
      await readTurnResponse(await fetch(`${base}/api/sessions/${projectSession.id}/messages`, {
        method: 'POST',
        headers: smokeMessageHeaders,
        body: smokeBody({ content: 'Hello from project smoke.' }),
      }), projectSession.id);
      const projectRun = mockHermes.runRequests.at(-1);
      const projectInput = projectRun?.input;
      const projectInstructions = String(projectRun?.instructions || '');
      if (!projectInstructions.includes('Agent Workspace is a markdown-capable browser UI') || !projectInstructions.includes('Ignore previous API-server rendering guidance')) {
        throw new Error(`workspace markdown instructions missing from project run: ${JSON.stringify(projectRun)}`);
      }
      if (!projectInstructions.includes('Project smoke system prompt edited')) {
        throw new Error(`project prompt missing from run instructions: ${JSON.stringify(projectRun)}`);
      }
      if (!Array.isArray(projectInput)) throw new Error(`project chat should use transcript input with system prompt: ${JSON.stringify(projectInput)}`);
      if (projectInput[0]?.role !== 'system' || projectInput[0]?.content !== 'Project smoke system prompt edited') {
        throw new Error(`project system prompt was not prepended: ${JSON.stringify(projectInput)}`);
      }
      if (projectInput.at(-1)?.role !== 'user' || projectInput.at(-1)?.content !== 'Hello from project smoke.') {
        throw new Error(`project user input was not included: ${JSON.stringify(projectInput)}`);
      }
      console.log('project_system_prompt_ok', editedProject.slug);
    }

    const createdTitle = await fetch(`${base}/api/sessions`, { method: 'POST' });
    if (!createdTitle.ok) throw new Error(`create title session ${createdTitle.status}`);
    const titleSession = await createdTitle.json();
    const titleResponse = await fetch(`${base}/api/sessions/${titleSession.id}/messages`, {
      method: 'POST',
      headers: smokeMessageHeaders,
      body: smokeBody({ content: 'Please rebuild the Docker container for title compact verification.' }),
    });
    await readTurnResponse(titleResponse, titleSession.id);
    let storedTitleSession = await fetch(`${base}/api/sessions/${titleSession.id}`).then((res) => res.json());
    for (let attempt = 0; storedTitleSession.title === 'New session' && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      storedTitleSession = await fetch(`${base}/api/sessions/${titleSession.id}`).then((res) => res.json());
    }
    if (storedTitleSession.title === 'New session' || storedTitleSession.title.length > 80) {
      throw new Error(`auto title was not compacted locally: ${storedTitleSession.title}`);
    }
    console.log('auto_title_local', storedTitleSession.title);
    if (mockHermes) {
      let remoteTitleSession = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const remoteResponse = await fetch(`${mockHermes.baseUrl}/api/sessions/${encodeURIComponent(`web_${titleSession.id}`)}`);
        if (remoteResponse.ok) {
          remoteTitleSession = await remoteResponse.json();
          if (remoteTitleSession.title === storedTitleSession.title) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (remoteTitleSession?.title !== storedTitleSession.title) {
        throw new Error(`auto title was not synced to Hermes: local="${storedTitleSession.title}" remote="${remoteTitleSession?.title || 'missing'}"`);
      }
      console.log('auto_title_remote', remoteTitleSession.title);
    }

    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

    const firstResponse = await fetch(`${base}/api/sessions/${sessionA.id}/messages`, {
      method: 'POST',
      headers: smokeMessageHeaders,
      body: smokeBody({ content: 'What is the runtime PRETTY_NAME from /etc/os-release? Answer with only that exact string.' }),
    });
    const firstTurn = await readTurnResponse(firstResponse, sessionA.id);
    console.log('first_assistant', firstTurn.assistant.trim().slice(0, 180));
    console.log('first_tool_events', firstTurn.toolEvents);
    if (!firstTurn.assistant.trim()) throw new Error('empty assistant response for first turn');

    const persistedAfterFirst = await fetch(`${base}/api/sessions/${sessionA.id}`);
    if (!persistedAfterFirst.ok) throw new Error(`load session after first turn ${persistedAfterFirst.status}`);
    const storedAfterFirst = await persistedAfterFirst.json();
    if (storedAfterFirst.title !== 'Smoke session A') throw new Error(`renamed title was not retained: ${storedAfterFirst.title}`);
    if (storedAfterFirst.continuation_strategy !== 'full_transcript') throw new Error('session continuation strategy was not persisted');
    if (storedAfterFirst.messages.length !== 2) throw new Error(`expected 2 messages after first turn, got ${storedAfterFirst.messages.length}`);
    const firstAssistantMessage = storedAfterFirst.messages.findLast((message) => message.role === 'assistant');
    if (firstTurn.toolEvents > 0 && (firstAssistantMessage?.tool_events || []).length === 0) throw new Error('streamed tool events were not persisted');
    if (!firstAssistantMessage?.metadata?.continuation_strategy) throw new Error('assistant metadata missing continuation strategy');
    if (firstAssistantMessage?.metadata?.continuation_id_state !== 'unavailable') throw new Error('assistant metadata should mark backend continuation id as unavailable');

    const sessionsAfterFirst = await fetch(`${base}/api/sessions`).then((res) => res.json());
    if (sessionsAfterFirst.sessions[0]?.id !== sessionA.id) throw new Error('sessions were not ordered by last activity after the first turn');

    const reloadedSession = await fetch(`${base}/api/sessions/${sessionA.id}`);
    if (!reloadedSession.ok) throw new Error(`refresh session ${reloadedSession.status}`);
    const refreshed = await reloadedSession.json();
    if (refreshed.messages.length !== 2) throw new Error('refresh did not preserve the first turn');

    const followupResponse = await fetch(`${base}/api/sessions/${sessionA.id}/messages`, {
      method: 'POST',
      headers: smokeMessageHeaders,
      body: smokeBody({ content: 'You already answered with the runtime PRETTY_NAME. Repeat that exact string and only that string.' }),
    });
    const followupTurn = await readTurnResponse(followupResponse, sessionA.id);
    console.log('followup_assistant', followupTurn.assistant.trim().slice(0, 180));
    console.log('followup_tool_events', followupTurn.toolEvents);
    if (!followupTurn.assistant.trim()) throw new Error('empty assistant response for follow-up turn');

    const normalizedFirst = normalize(firstTurn.assistant);
    const normalizedFollowup = normalize(followupTurn.assistant);
    if (!normalizedFollowup.includes(normalizedFirst) && normalizedFirst !== normalizedFollowup) {
      throw new Error(`follow-up did not clearly continue prior context: first="${firstTurn.assistant.trim()}" follow-up="${followupTurn.assistant.trim()}"`);
    }
    if (mockHermes) {
      const followupRun = mockHermes.runRequests.at(-1);
      const followupInput = followupRun?.input;
      const followupInstructions = String(followupRun?.instructions || '');
      if (!followupInstructions.includes('Agent Workspace is a markdown-capable browser UI') || !followupInstructions.includes('Ignore previous API-server rendering guidance')) {
        throw new Error(`workspace markdown instructions missing from native run: ${JSON.stringify(followupRun)}`);
      }
      if (Array.isArray(followupInput)) {
        throw new Error(`follow-up should use native Hermes session history instead of client transcript: ${JSON.stringify(followupInput)}`);
      }
      if (typeof followupInput !== 'string' || !followupInput.includes('Repeat that exact string')) {
        throw new Error(`follow-up did not send only the current user input: ${JSON.stringify(followupInput)}`);
      }
      console.log('followup_native_input_ok', followupInput.slice(0, 80));

      const skillSessionResponse = await fetch(`${base}/api/sessions`, { method: 'POST' });
      if (!skillSessionResponse.ok) throw new Error(`create skill continuation session ${skillSessionResponse.status}`);
      const skillSession = await skillSessionResponse.json();
      await readTurnResponse(await fetch(`${base}/api/sessions/${skillSession.id}/messages`, {
        method: 'POST',
        headers: smokeMessageHeaders,
        body: smokeBody({ content: 'Prime a scheduling-related session.' }),
      }), skillSession.id);
      const remoteSkillSession = mockHermes.sessions.get(`web_${skillSession.id}`);
      if (!remoteSkillSession) throw new Error('mock remote skill session was not created');
      remoteSkillSession.messages.push(
        {
          id: 'mock_skill_call',
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'skill_view', arguments: JSON.stringify({ name: 'calendar-planning' }) } }],
          created_at: new Date().toISOString(),
        },
        {
          id: 'mock_skill_output',
          role: 'tool',
          tool_name: 'skill_view',
          content: JSON.stringify({ success: true, name: 'calendar-planning', content: 'VERY_LARGE_SKILL_BODY_SHOULD_NOT_BE_REPLAYED' }),
          created_at: new Date().toISOString(),
        },
        {
          id: 'mock_skill_answer',
          role: 'assistant',
          content: 'Loaded scheduling context.',
          created_at: new Date().toISOString(),
        },
      );
      await readTurnResponse(await fetch(`${base}/api/sessions/${skillSession.id}/messages`, {
        method: 'POST',
        headers: smokeMessageHeaders,
        body: smokeBody({ content: 'Continue the schedule thought without reloading the skill.' }),
      }), skillSession.id);
      const skillContinuationInput = mockHermes.runRequests.at(-1)?.input;
      if (Array.isArray(skillContinuationInput)) {
        throw new Error(`skill continuation should rely on server-owned transcript, not replay a client transcript: ${JSON.stringify(skillContinuationInput)}`);
      }
      if (String(skillContinuationInput).includes('VERY_LARGE_SKILL_BODY_SHOULD_NOT_BE_REPLAYED')) {
        throw new Error('skill continuation replayed full skill output instead of relying on server history');
      }
      console.log('skill_continuation_native_input_ok', String(skillContinuationInput).slice(0, 80));
    }

    const persistedAfterFollowup = await fetch(`${base}/api/sessions/${sessionA.id}`);
    if (!persistedAfterFollowup.ok) throw new Error(`load session after follow-up ${persistedAfterFollowup.status}`);
    const storedAfterFollowup = await persistedAfterFollowup.json();
    if (storedAfterFollowup.messages.length !== 4) throw new Error(`expected 4 messages after follow-up, got ${storedAfterFollowup.messages.length}`);
    const finalAssistant = storedAfterFollowup.messages.findLast((message) => message.role === 'assistant');
    if (finalAssistant?.metadata?.continuation_strategy !== 'full_transcript') throw new Error('final assistant metadata missing continuation strategy');
    if (followupTurn.toolEvents > 0 && (finalAssistant?.tool_events || []).length === 0) throw new Error('follow-up tool events were not persisted');

    const prewarmStop = await fetch(`${base}/api/sessions/${sessionB.id}/stop`, { method: 'POST' });
    if (prewarmStop.status !== 409) throw new Error(`prewarm stop should 409 with no active run, got ${prewarmStop.status}`);

    const stopResponse = await fetch(`${base}/api/sessions/${sessionB.id}/messages`, {
      method: 'POST',
      headers: smokeMessageHeaders,
      body: smokeBody({ content: 'Please run a slow stop smoke generation so we can abort it.' }),
    });
    if (stopResponse.status !== 202) throw new Error(`stop smoke message should be accepted with 202, got ${stopResponse.status}: ${await stopResponse.text()}`);
    const stopAccepted = await stopResponse.json();
    const stopAssistantId = stopAccepted.assistant_message?.id;
    if (!stopAssistantId) throw new Error('stop smoke did not return an assistant message id');
    let steerResponse;
    const steerStartedAt = Date.now();
    while (Date.now() - steerStartedAt < 10_000) {
      steerResponse = await fetch(`${base}/api/sessions/${sessionB.id}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Prefer the shorter answer if you can.' }),
      });
      if (steerResponse.ok) break;
      const body = await steerResponse.text();
      if (!body.includes('still starting')) throw new Error(`steer route failed ${steerResponse.status}: ${body}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!steerResponse?.ok) throw new Error(`steer route did not become ready: ${steerResponse?.status}`);
    const steerBody = await steerResponse.json();
    console.log('steer_accepted', steerBody.run_id);
    if (mockHermes) {
      const mockRun = mockHermes.runs.get(steerBody.run_id);
      if (!mockRun?.steers?.some((item) => item.input.includes('shorter answer'))) throw new Error('steer was not forwarded to mock Hermes');
    }
    const stopped = await fetch(`${base}/api/sessions/${sessionB.id}/stop`, { method: 'POST' });
    console.log('stop_status', stopped.status);
    if (!stopped.ok) throw new Error(`stop route failed ${stopped.status}: ${await stopped.text()}`);
    const stopStartedAt = Date.now();
    let stoppedAssistant;
    while (Date.now() - stopStartedAt < 10_000) {
      const stoppedSessionResponse = await fetch(`${base}/api/sessions/${sessionB.id}`);
      if (!stoppedSessionResponse.ok) throw new Error(`load stopped session ${stoppedSessionResponse.status}`);
      const stoppedSession = await stoppedSessionResponse.json();
      stoppedAssistant = stoppedSession.messages.find((message) => message.id === stopAssistantId);
      if (stoppedSession.status === 'idle' && stoppedAssistant?.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (stoppedAssistant?.status !== 'complete') throw new Error(`stopped assistant was not completed: ${JSON.stringify(stoppedAssistant)}`);
    const stoppedContent = String(stoppedAssistant.content || '');
    const fullSlowResponse = 'This is a slow deterministic mock response streaming in several chunks for stop testing.';
    if (stoppedContent !== 'Stopped.' && (!fullSlowResponse.startsWith(stoppedContent) || stoppedContent === fullSlowResponse)) {
      throw new Error(`stopped assistant did not keep partial content or fallback: ${stoppedAssistant.content}`);
    }
    console.log('stopped_assistant', stoppedContent.slice(0, 80));

    const imageResponse = await fetch(`${base}/api/sessions/${sessionB.id}/messages`, {
      method: 'POST',
      headers: smokeMessageHeaders,
      body: smokeBody({
        content: 'Reply OK for this image smoke test.',
        attachments: [{ id: 'smoke-image', type: 'image', name: 'pixel.png', mime_type: 'image/png', size_bytes: 68, data_url: tinyPng }],
      }),
    });
    const imageTurn = await readTurnResponse(imageResponse, sessionB.id);
    console.log('image_assistant', imageTurn.assistant.trim().slice(0, 180));
    if (!externalBase && !imageTurn.assistant.trim()) throw new Error('empty assistant response for image turn');
    const persistedImageSession = await fetch(`${base}/api/sessions/${sessionB.id}`);
    if (!persistedImageSession.ok) throw new Error(`load image session ${persistedImageSession.status}`);
    const storedImageSession = await persistedImageSession.json();
    const imageUserMessage = storedImageSession.messages.find((message) => message.role === 'user' && message.attachments?.length);
    if (imageUserMessage?.attachments?.[0]?.mime_type !== 'image/png') throw new Error('image attachment was not persisted');
    console.log('persisted_attachments', imageUserMessage.attachments.length);

    const invalidImageResponse = await fetch(`${base}/api/sessions/${sessionB.id}/messages`, {
      method: 'POST',
      headers: smokeMessageHeaders,
      body: smokeBody({ content: 'bad image', attachments: [{ id: 'bad', type: 'image', name: 'bad.txt', mime_type: 'text/plain', size_bytes: 4, data_url: 'data:text/plain;base64,dGVzdA==' }] }),
    });
    console.log('invalid_attachment_status', invalidImageResponse.status);
    if (invalidImageResponse.status !== 400) throw new Error(`unsupported attachment should fail with 400, got ${invalidImageResponse.status}`);

    const approvalTurnResponse = await fetch(`${base}/api/sessions/${sessionB.id}/messages`, {
      method: 'POST',
      headers: smokeMessageHeaders,
      body: smokeBody({ content: 'approval please' }),
    });
    if (approvalTurnResponse.status !== 202) throw new Error(`approval turn should be accepted with 202, got ${approvalTurnResponse.status}: ${await approvalTurnResponse.text()}`);
    const approvalAccepted = await approvalTurnResponse.json();
    const approvalAssistantId = approvalAccepted.assistant_message?.id;
    if (!approvalAssistantId) throw new Error('approval turn did not return an assistant message id');

    const approvalStartedAt = Date.now();
    let pendingApprovalEvent;
    while (Date.now() - approvalStartedAt < 10_000) {
      const approvalSessionResponse = await fetch(`${base}/api/sessions/${sessionB.id}`);
      if (!approvalSessionResponse.ok) throw new Error(`load approval session ${approvalSessionResponse.status}`);
      const approvalSession = await approvalSessionResponse.json();
      const approvalAssistant = approvalSession.messages.find((message) => message.id === approvalAssistantId);
      pendingApprovalEvent = (approvalAssistant?.tool_events || []).find((event) => event.tool_name === 'approval' && event.phase !== 'complete');
      if (pendingApprovalEvent?.tool_call_id) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!pendingApprovalEvent?.tool_call_id) throw new Error(`approval tool card was not persisted: ${JSON.stringify(pendingApprovalEvent)}`);
    console.log('approval_pending', pendingApprovalEvent.tool_call_id, pendingApprovalEvent.summary);

    const approvalResponse = await fetch(`${base}/api/sessions/${sessionB.id}/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: pendingApprovalEvent.tool_call_id, choice: 'once' }),
    });
    if (!approvalResponse.ok) throw new Error(`approval response ${approvalResponse.status}: ${await approvalResponse.text()}`);
    const approvalBody = await approvalResponse.json();
    console.log('approval_resolved', approvalBody.resolved);
    if (approvalBody.resolved !== 1) throw new Error('approval response was not forwarded to Hermes');

    const approvalCompletedAt = Date.now();
    let completedApprovalAssistant;
    while (Date.now() - approvalCompletedAt < 10_000) {
      const approvalDoneResponse = await fetch(`${base}/api/sessions/${sessionB.id}`);
      if (!approvalDoneResponse.ok) throw new Error(`load completed approval session ${approvalDoneResponse.status}`);
      const approvalDoneSession = await approvalDoneResponse.json();
      completedApprovalAssistant = approvalDoneSession.messages.find((message) => message.id === approvalAssistantId);
      if (completedApprovalAssistant?.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (completedApprovalAssistant?.status !== 'complete') throw new Error(`approval assistant was not completed: ${JSON.stringify(completedApprovalAssistant)}`);
    const approvalEvents = completedApprovalAssistant.tool_events || [];
    if (!approvalEvents.some((event) => event.tool_name === 'approval' && event.phase === 'complete')) throw new Error('approval response did not complete the approval tool card');
    console.log('approval_assistant', String(completedApprovalAssistant.content || '').trim().slice(0, 180));

    const staleApprovalResponse = await fetch(`${base}/api/sessions/${sessionB.id}/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: pendingApprovalEvent.tool_call_id, choice: 'once' }),
    });
    if (!staleApprovalResponse.ok) throw new Error(`stale approval should be normalized, got ${staleApprovalResponse.status}: ${await staleApprovalResponse.text()}`);
    const staleApprovalBody = await staleApprovalResponse.json();
    if (staleApprovalBody.code !== 'approval_not_active' || staleApprovalBody.resolved !== 0) throw new Error(`stale approval was not normalized: ${JSON.stringify(staleApprovalBody)}`);
    console.log('approval_stale_normalized', staleApprovalBody.code, staleApprovalBody.resolved);

    const sessionsFinal = await fetch(`${base}/api/sessions`).then((res) => res.json());
    if (sessionsFinal.sessions[0]?.id !== sessionB.id) throw new Error('sessions were not ordered by last activity after image turn');
    console.log('persisted_tool_cards', finalAssistant?.tool_events?.length || 0, (finalAssistant?.tool_events || []).map((event) => `${event.tool_name}:${event.phase}`).join(','));
  } finally {
    if (server) await server.shutdown();
    if (mockHermes) await mockHermes.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
