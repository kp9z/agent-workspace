import { getSession, updateAssistantTurn, failRunningTurn } from '@/lib/store';
import { HermesHttpError, steerHermesRun } from '@/lib/hermes';
import { runningTurns } from '@/lib/run-registry';
import type { ToolEvent } from '@/lib/types';
import { JSON_BODY_GENERAL_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

const MAX_STEER_LENGTH = 8_000;

function staleRunResponse(message = 'Running turn is stale or missing. Reloading session.') {
  return Response.json({ error: message, code: 'stale_run' }, { status: 409 });
}

function steerToolEvent(runId: string, input: string): ToolEvent {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tool_call_id: runId,
    tool_name: 'steer',
    phase: 'complete',
    status: 'complete',
    summary: `Steered: ${input.slice(0, 120)}${input.length > 120 ? '…' : ''}`,
    created_at: now,
    updated_at: now,
    raw_payload: { run_id: runId, input },
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSession(id);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });

  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  const input = String(body.content || body.input || '').trim();
  if (!input) return Response.json({ error: 'Steer content is required' }, { status: 400 });
  if (input.length > MAX_STEER_LENGTH) return Response.json({ error: `Steer content must be ${MAX_STEER_LENGTH} characters or fewer` }, { status: 400 });

  const running = runningTurns.get(id);
  if (session.status !== 'running' || !running) {
    return Response.json({ error: 'This chat does not have a running turn to steer.' }, { status: 409 });
  }
  if (!running.hermes_run_id) return staleRunResponse();

  try {
    await steerHermesRun(running.hermes_run_id, input);
  } catch (error) {
    if (error instanceof HermesHttpError && error.status === 404) {
      await failRunningTurn(id, 'Previous run is no longer available. Please send the message again.');
      return staleRunResponse();
    }
    throw error;
  }

  const steerEvent = steerToolEvent(running.hermes_run_id, input);
  running.injected_tool_events = [...(running.injected_tool_events || []), steerEvent];
  const assistant = session.messages.find((message) => message.id === running.assistant_message_id);
  const toolEvents = [...(assistant?.tool_events || []), steerEvent];
  if (assistant) {
    await updateAssistantTurn(id, running.assistant_message_id, { toolEvents, status: 'streaming' });
  }

  return Response.json({ accepted: true, run_id: running.hermes_run_id });
}
