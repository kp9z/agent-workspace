export type Role = 'user' | 'assistant' | 'system';

export type ToolEvent = {
  id: string;
  tool_call_id?: string;
  tool_name: string;
  phase: 'called' | 'running' | 'output' | 'failed' | 'complete';
  summary: string;
  status?: string;
  output?: string;
  created_at: string;
  updated_at?: string;
  raw_payload?: Record<string, unknown>;
};

export type Attachment = {
  id: string;
  type: 'image';
  name: string;
  mime_type: string;
  data_url?: string;
  url?: string;
  size_bytes: number;
};

export type Message = {
  id: string;
  role: Role;
  content: string;
  status: 'pending' | 'streaming' | 'complete' | 'failed';
  created_at: string;
  attachments?: Attachment[];
  tool_events?: ToolEvent[];
  metadata?: Record<string, unknown>;
};

export type ChatSession = {
  id: string;
  hermes_session_id?: string;
  project_id?: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  runtime_id: string;
  continuation_strategy: 'full_transcript' | 'previous_response_id' | string;
  status: 'idle' | 'running' | 'failed';
  last_error?: string;
  pinned_at?: string | null;
  archived_at?: string | null;
  messages: Message[];
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  system_prompt: string;
  created_at: string;
  updated_at: string;
};

export type RuntimeInfo = {
  id: string;
  name: string;
  base_url: string;
  profile: string;
  model_label: string;
  execution_host_label: string;
  status: 'ok' | 'error';
  version?: string;
  error?: string;
  capabilities?: Record<string, unknown>;
};

export type UiStreamEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; tool_name: string; summary: string; status?: string; toolCallId?: string; output?: string; raw_payload?: Record<string, unknown> }
  | { type: 'tool_output'; tool_name: string; summary: string; status?: string; toolCallId?: string; output?: string; raw_payload?: Record<string, unknown> }
  | { type: 'approval_result'; run_id: string; choice: string; resolved?: number }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'done'; message_id: string };
