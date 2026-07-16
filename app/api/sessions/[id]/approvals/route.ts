import { NextResponse } from 'next/server';
import { respondToHermesApproval } from '@/lib/hermes';
import { getSession, updateAssistantTurn } from '@/lib/store';
import type { ToolEvent } from '@/lib/types';
import { JSON_BODY_GENERAL_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

const choices = new Set(['once', 'session', 'always', 'deny']);

function approvalRunId(event: ToolEvent) {
  const raw = event.raw_payload || {};
  return typeof raw.run_id === 'string' ? raw.run_id : event.tool_call_id?.startsWith('run_') ? event.tool_call_id : undefined;
}

function isApprovalNotActive(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('approval_not_active') || message.includes('No active approval session') || message.includes('returned 409');
}

async function markApprovalExpired(sessionId: string, runId: string) {
  const session = await getSession(sessionId);
  const assistant = session?.messages.find((message) => (
    message.role === 'assistant' && (message.tool_events || []).some((event) => approvalRunId(event) === runId)
  ));
  if (!assistant) return false;

  const now = new Date().toISOString();
  const toolEvents = (assistant.tool_events || []).map((event) => {
    if (approvalRunId(event) !== runId || event.phase === 'complete' || event.phase === 'failed') return event;
    return {
      ...event,
      phase: 'failed' as const,
      status: 'expired',
      summary: `${event.summary}\n\nThis approval expired because Hermes no longer has an active approval session for this run. Start a new turn if the command still needs to run.`,
      updated_at: now,
      raw_payload: { ...(event.raw_payload || {}), run_id: runId, stale: true, code: 'approval_not_active' },
    };
  });
  await updateAssistantTurn(sessionId, assistant.id, { toolEvents, status: assistant.status });
  return true;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  const runId = typeof body.run_id === 'string' ? body.run_id.trim() : '';
  const choice = typeof body.choice === 'string' ? body.choice.trim().toLowerCase() : '';
  if (!runId) return NextResponse.json({ error: 'run_id is required' }, { status: 400 });
  if (!choices.has(choice)) return NextResponse.json({ error: 'choice must be once, session, always, or deny' }, { status: 400 });
  try {
    const result = await respondToHermesApproval(runId, choice as 'once' | 'session' | 'always' | 'deny');
    return NextResponse.json(result);
  } catch (error) {
    if (isApprovalNotActive(error)) {
      await markApprovalExpired(id, runId);
      return NextResponse.json({ run_id: runId, choice, resolved: 0, stale: true, code: 'approval_not_active' });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
