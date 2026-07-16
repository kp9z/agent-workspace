import type { Message, ToolEvent } from '@/lib/types';

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';
export type PendingApproval = { runId: string; summary: string; status?: string; messageId: string; eventId: string };

export function approvalRunId(event: ToolEvent) {
  const raw = event.raw_payload || {};
  return typeof raw.run_id === 'string' ? raw.run_id : event.tool_call_id?.startsWith('run_') ? event.tool_call_id : undefined;
}

export function isPendingApprovalEvent(event: ToolEvent) {
  return (event.tool_name === 'approval' || event.status === 'pending_approval') && event.phase !== 'complete' && event.phase !== 'failed';
}

export function findPendingApproval(messages: Message[]) {
  for (const message of [...messages].reverse()) {
    const event = [...(message.tool_events || [])].reverse().find(isPendingApprovalEvent);
    if (!event) continue;
    const runId = approvalRunId(event);
    if (!runId) continue;
    return { runId, summary: event.summary, status: event.status, messageId: message.id, eventId: event.id };
  }
  return null;
}

function parseToolArguments(raw: Record<string, unknown> | undefined) {
  if (!raw) return undefined;
  const value = raw.arguments ?? raw.args ?? raw.input ?? raw.parameters;
  if (!value) return undefined;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function toolDisplayName(event: ToolEvent) {
  if (event.tool_name !== 'skill_view') return event.tool_name;
  const args = parseToolArguments(event.raw_payload);
  const name = typeof args?.name === 'string' ? args.name : undefined;
  const filePath = typeof args?.file_path === 'string' ? args.file_path : undefined;
  return name ? `skill_view: ${name}${filePath ? `/${filePath}` : ''}` : event.tool_name;
}

export function toolDisplayStatus(event: ToolEvent) {
  const raw = event.status || event.phase;
  const cleaned = raw.replace(/^tool\./, '').replace(/^approval\./, '').replace(/_/g, ' ');
  return cleaned === 'complete' ? 'completed' : cleaned;
}

export function visibleToolEvents(message: Message) {
  return message.tool_events || [];
}

export function runProgressLabel(message: Message) {
  if (message.status === 'failed' || message.status === 'complete') return '';
  const toolEvents = message.tool_events || [];
  const activeTool = [...toolEvents].reverse().find((event) => event.phase !== 'complete' && event.phase !== 'failed');
  if (activeTool) return `using ${toolDisplayName(activeTool)}`;
  if (toolEvents.length > 0 && !message.content.trim()) return 'waiting on tool output';
  if (message.content.trim()) return 'streaming';
  return 'thinking';
}
