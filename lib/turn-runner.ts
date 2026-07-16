import { createPendingTurn, failRunningTurn, getSession, isDefaultSessionTitle, updateAssistantTurn, updateSessionStatus } from '@/lib/store';
import { applyToolEvent, streamHermesTurn } from '@/lib/hermes';
import { autoTitleSessionFromFirstMessage } from '@/lib/title-generator';
import { runningTurns } from '@/lib/run-registry';
import { queueAttentionNotification } from '@/lib/notifications';
import type { Attachment, Message, ToolEvent, UiStreamEvent } from '@/lib/types';

type TurnOptions = {
  suppressNotifications?: boolean;
};

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function approvalEventKey(event: UiStreamEvent) {
  if (event.type !== 'tool_call' || event.tool_name !== 'approval') return null;
  const rawRunId = event.raw_payload?.run_id;
  const runId = typeof rawRunId === 'string' && rawRunId.trim() ? rawRunId : event.toolCallId;
  return runId ? `approval_needed:${runId}` : null;
}

async function runTurnInBackground(
  sessionId: string,
  assistantMessageId: string,
  input: string,
  attachments: Attachment[],
  signal: AbortSignal,
  options: TurnOptions = {},
) {
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  let assistant = '';
  let persistedAssistant = '';
  let toolEvents: ToolEvent[] = [];
  let lastFlushAt = 0;
  const flushAssistantTurn = async (status: 'streaming' | 'complete' | 'failed', error?: string, force = false) => {
    const injectedToolEvents = runningTurns.get(sessionId)?.injected_tool_events || [];
    const now = Date.now();
    const shouldFlushContent = force || status !== 'streaming' || assistant !== persistedAssistant;
    const shouldThrottle = status === 'streaming' && !force && now - lastFlushAt < 350;
    if (!shouldFlushContent && status === 'streaming') return;
    if (shouldThrottle) return;
    persistedAssistant = assistant;
    lastFlushAt = now;
    await updateAssistantTurn(sessionId, assistantMessageId, {
      content: assistant,
      toolEvents: [...toolEvents, ...injectedToolEvents],
      status,
      error,
    });
  };
  try {
    for await (const event of streamHermesTurn(session, input, attachments, signal, {
      onRunId: (runId) => {
        const running = runningTurns.get(sessionId);
        if (running?.assistant_message_id === assistantMessageId) running.hermes_run_id = runId;
      },
    })) {
      if (event.type === 'assistant_delta') assistant += event.text;
      const approvalKey = approvalEventKey(event);
      if (approvalKey) {
        if (!options.suppressNotifications) {
          queueAttentionNotification({ type: 'approval_needed', sessionId, eventKey: approvalKey });
        }
      }
      const nextToolEvents = applyToolEvent(toolEvents, event);
      const toolEventsChanged = nextToolEvents !== toolEvents;
      toolEvents = nextToolEvents;
      if (event.type === 'error') throw new Error(event.message);
      await flushAssistantTurn('streaming', undefined, event.type !== 'assistant_delta' || toolEventsChanged);
    }
    await flushAssistantTurn('complete', undefined, true);
    if (!options.suppressNotifications) {
      queueAttentionNotification({ type: 'run_succeeded', sessionId, eventKey: `run_succeeded:${assistantMessageId}` });
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      if (!assistant) assistant = 'Stopped.';
      await flushAssistantTurn('complete', undefined, true).catch(() => updateSessionStatus(sessionId, 'idle'));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!assistant) assistant = message;
    await flushAssistantTurn('failed', message, true).catch(() => updateSessionStatus(sessionId, 'failed', message));
    if (!options.suppressNotifications) {
      queueAttentionNotification({ type: 'run_failed', sessionId, eventKey: `run_failed:${assistantMessageId}` });
    }
  } finally {
    runningTurns.delete(sessionId);
    import('@/lib/server-queue').then(({ drainQueuedTurns }) => drainQueuedTurns()).catch((error) => {
      console.error('Agent Workspace queue drain trigger failed', error);
    });
  }
}

export async function startTurn(
  sessionId: string,
  input: string,
  attachments: Attachment[],
  clientTurnId?: string,
  options: TurnOptions = {},
): Promise<{ user_message: Message; assistant_message: Message; deduped?: boolean }> {
  let session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');

  if (session.status === 'running' && !runningTurns.has(sessionId)) {
    session = (await failRunningTurn(sessionId, 'Previous run was interrupted after the browser/server connection was lost. Please send the message again.')) ?? session;
  }

  if (session.status === 'running' || runningTurns.has(sessionId)) {
    if (clientTurnId) {
      const existingAssistantIndex = session.messages.findIndex(
        (message) => message.role === 'assistant' && message.metadata?.client_turn_id === clientTurnId,
      );
      if (existingAssistantIndex > 0) {
        return {
          user_message: session.messages[existingAssistantIndex - 1],
          assistant_message: session.messages[existingAssistantIndex],
          deduped: true,
        };
      }
    }
    throw new Error('This chat already has a running turn. Open a new chat to run in parallel.');
  }

  const shouldAutoTitle = isDefaultSessionTitle(session.title) && session.messages.filter((message) => message.role === 'user').length === 0;
  const { userMessage, assistantMessage } = await createPendingTurn(sessionId, input, attachments, clientTurnId);
  if (shouldAutoTitle) autoTitleSessionFromFirstMessage(sessionId, input);
  if (clientTurnId && assistantMessage.metadata?.client_turn_id === clientTurnId && assistantMessage.status !== 'streaming') {
    return { user_message: userMessage, assistant_message: assistantMessage, deduped: true };
  }
  const controller = new AbortController();
  const promise = runTurnInBackground(sessionId, assistantMessage.id, input, attachments, controller.signal, options);
  runningTurns.set(sessionId, { promise, started_at: new Date().toISOString(), assistant_message_id: assistantMessage.id, client_turn_id: clientTurnId, controller });
  promise.catch((error) => {
    console.error('Agent Workspace background turn failed', error);
  });
  return { user_message: userMessage, assistant_message: assistantMessage };
}
