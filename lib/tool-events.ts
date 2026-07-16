import type { ToolEvent, UiStreamEvent } from './types';

function newId() {
  return globalThis.crypto?.randomUUID?.() || `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function phaseFor(event: Extract<UiStreamEvent, { type: 'tool_call' | 'tool_output' }>): ToolEvent['phase'] {
  if (event.type === 'tool_call') return 'running';
  return event.status === 'failed' ? 'failed' : 'complete';
}

function eventKey(event: Extract<UiStreamEvent, { type: 'tool_call' | 'tool_output' }>) {
  return event.toolCallId || `${event.tool_name}:active`;
}

export function upsertToolEvent(
  events: ToolEvent[],
  event: UiStreamEvent,
  options: { now?: string; id?: string } = {},
): ToolEvent[] {
  if (event.type !== 'tool_call' && event.type !== 'tool_output') return events;

  const now = options.now || new Date().toISOString();
  const key = eventKey(event);
  const nextPhase = phaseFor(event);
  const index = events.findIndex((existing) => {
    if (event.toolCallId && existing.tool_call_id === event.toolCallId) return true;
    return !event.toolCallId && existing.tool_name === event.tool_name && existing.phase !== 'complete' && existing.phase !== 'failed';
  });

  if (index >= 0) {
    return events.map((existing, itemIndex) => {
      if (itemIndex !== index) return existing;
      return {
        ...existing,
        phase: nextPhase,
        status: event.status || existing.status,
        summary: event.summary || existing.summary,
        output: event.output || existing.output,
        updated_at: now,
        raw_payload: event.raw_payload || existing.raw_payload,
      };
    });
  }

  return [
    ...events,
    {
      id: options.id || newId(),
      tool_call_id: event.toolCallId || key,
      tool_name: event.tool_name,
      phase: nextPhase,
      summary: event.summary,
      status: event.status,
      output: event.output,
      raw_payload: event.raw_payload,
      created_at: now,
      updated_at: now,
    },
  ];
}
