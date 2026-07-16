'use client';

import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { branding } from '@/lib/branding';
import type { Message } from '@/lib/types';
import { messageRenderSignature } from '@/lib/message-render-signature';
import type { ApprovalChoice } from './transcript-utils';
import { approvalRunId, findPendingApproval, runProgressLabel, toolDisplayName, toolDisplayStatus, visibleToolEvents } from './transcript-utils';

export type TranscriptPanelProps = {
  messages: Message[];
  hiddenMessageCount: number;
  streamingMessage: Message | null;
  onRevealOlder?: () => void;
  onApproval?: (runId: string, choice: ApprovalChoice) => void;
  approvalSubmitting?: string | null;
  onFork?: (messageId: string) => void;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function textFromNode(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return textFromNode(props?.children);
  }
  return '';
}

function IconSvg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className ?? 'h-6 w-6'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <IconSvg className={className}>
      <path d="m9 18 6-6-6-6" />
    </IconSvg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <IconSvg className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </IconSvg>
  );
}

function ForkIcon({ className }: { className?: string }) {
  return (
    <IconSvg className={className}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M6 8v4a4 4 0 0 0 4 4h2" />
      <path d="M18 8v4a4 4 0 0 1-4 4h-2" />
    </IconSvg>
  );
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-full border border-neutral-300 bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-neutral-600 shadow-sm transition hover:bg-neutral-100"
      aria-label={label}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function MessageCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="message-action-button inline-flex h-7 items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-semibold transition focus:outline-none focus:ring-2"
      aria-label="Copy assistant response"
      title="Copy response"
    >
      <CopyIcon className="h-4 w-4" />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

const markdownComponents: Components = {
  table({ children }) {
    const tableText = textFromNode(children);
    return (
      <div className="markdown-block group my-4 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Table</span>
          <CopyButton value={tableText} label="Copy" />
        </div>
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table>{children}</table>
        </div>
      </div>
    );
  },
  pre({ children }) {
    const blockText = textFromNode(children);
    return (
      <div className="markdown-block group my-4 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Code block</span>
          <CopyButton value={blockText} label="Copy code" />
        </div>
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <pre>{children}</pre>
        </div>
      </div>
    );
  },
  blockquote({ children }) {
    return <blockquote>{children}</blockquote>;
  },
  a({ children, href, node: _node, ...props }) {
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer" className="markdown-link">
        {children}
      </a>
    );
  },
};

function ProgressPill({ label }: { label: string }) {
  if (!label) return null;
  return (
    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-medium text-neutral-500" aria-live="polite">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="thinking-dot" />
        <span className="thinking-dot thinking-dot-delay-1" />
        <span className="thinking-dot thinking-dot-delay-2" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function ThinkingBubble({ label = 'thinking' }: { label?: string }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-[24px] border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-500 shadow-sm" aria-label={`${branding.agentDisplayName} is ${label}`}>
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="thinking-dot" />
        <span className="thinking-dot thinking-dot-delay-1" />
        <span className="thinking-dot thinking-dot-delay-2" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function ApprovalButtons({ runId, onApproval, submittingKey, compact = false }: { runId: string; onApproval: (runId: string, choice: ApprovalChoice) => void; submittingKey?: string | null; compact?: boolean }) {
  const choices: Array<{ choice: ApprovalChoice; label: string; className: string }> = [
    { choice: 'once', label: 'Approve once', className: 'approval-button-primary' },
    { choice: 'session', label: 'This session', className: 'approval-button-secondary' },
    { choice: 'always', label: 'Always', className: 'approval-button-secondary' },
    { choice: 'deny', label: 'Deny', className: 'approval-button-danger' },
  ];
  const submittingChoice = submittingKey?.startsWith(`${runId}:`) ? submittingKey.split(':')[1] : null;
  return (
    <div className={cx('flex flex-wrap gap-2', compact ? 'mt-3' : 'mt-4')}>
      {choices.map((item) => {
        const disabled = Boolean(submittingChoice);
        return (
          <button
            key={item.choice}
            type="button"
            onClick={() => onApproval(runId, item.choice)}
            disabled={disabled}
            className={cx('approval-button inline-flex items-center justify-center rounded-full font-semibold leading-none disabled:cursor-not-allowed disabled:opacity-60', compact ? 'h-8 px-3 text-xs' : 'h-9 px-3.5 text-sm', item.className)}
          >
            {submittingChoice === item.choice ? 'Sending…' : item.label}
          </button>
        );
      })}
    </div>
  );
}

function ApprovalBanner({ approval, onApproval, submittingKey }: { approval: NonNullable<ReturnType<typeof findPendingApproval>>; onApproval: (runId: string, choice: ApprovalChoice) => void; submittingKey?: string | null }) {
  return (
    <section className="approval-panel rounded-2xl p-3 text-sm shadow-sm" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="approval-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" aria-hidden="true">!</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <div className="approval-title font-semibold leading-5">Approval needed</div>
            <div className="approval-meta min-w-0 truncate text-xs font-medium">{approval.status || 'pending'} · run {approval.runId}</div>
          </div>
          <p className="approval-summary mt-1 whitespace-pre-wrap leading-5 [overflow-wrap:anywhere]">{approval.summary}</p>
          <ApprovalButtons runId={approval.runId} onApproval={onApproval} submittingKey={submittingKey} />
        </div>
      </div>
    </section>
  );
}

function ToolCard({ event, onApproval, approvalSubmitting }: { event: NonNullable<Message['tool_events']>[number]; onApproval?: (runId: string, choice: ApprovalChoice) => void; approvalSubmitting?: string | null }) {
  const complete = event.phase === 'complete';
  const isApproval = event.tool_name === 'approval' || event.status === 'pending_approval';
  const runId = isApproval ? approvalRunId(event) : undefined;
  const submittingThisApproval = Boolean(runId && approvalSubmitting?.startsWith(`${runId}:`));
  return (
    <details className={cx('mt-3 min-w-0 overflow-hidden rounded-2xl border p-3 text-sm', isApproval ? 'approval-panel' : 'border-neutral-200 bg-neutral-50')} open={!complete}>
      <summary className={cx('tool-summary flex cursor-pointer list-none items-center gap-2 leading-5 [overflow-wrap:anywhere]', isApproval ? 'approval-title' : 'text-neutral-700')}>
        <ChevronRightIcon className="tool-summary-chevron h-4 w-4 shrink-0 text-current" />
        <span className="font-semibold">{isApproval ? 'Approval needed' : toolDisplayName(event)}</span>
        <span className={cx('ml-1 text-xs font-medium', isApproval ? 'approval-meta' : 'text-neutral-400')}>{submittingThisApproval ? 'submitting…' : toolDisplayStatus(event)}</span>
      </summary>
      <p className={cx('mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]', isApproval ? 'approval-summary' : 'text-neutral-600')}>{event.summary}</p>
      {isApproval && runId && onApproval && event.phase !== 'complete' && event.phase !== 'failed' && (
        <ApprovalButtons runId={runId} onApproval={onApproval} submittingKey={approvalSubmitting} compact />
      )}
      {isApproval && !runId && <p className="mt-2 text-xs text-amber-700">Approval event did not include a run id, so it cannot be resolved from the browser.</p>}
      {event.output && (
        <div className="relative mt-2 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          <div className="flex items-center justify-end border-b border-neutral-200 bg-neutral-50 px-2 py-1.5">
            <CopyButton value={event.output} label="Copy" />
          </div>
          <pre className="max-h-64 max-w-full overflow-x-auto overflow-y-hidden whitespace-pre-wrap break-words p-3 text-xs text-neutral-700 [-webkit-overflow-scrolling:touch]">{event.output}</pre>
        </div>
      )}
      <div className="mt-2 text-xs text-neutral-400">{event.updated_at || event.created_at}</div>
    </details>
  );
}

const ChatMessage = memo(function ChatMessage({
  message,
  onApproval,
  approvalSubmitting,
  onFork,
}: {
  message: Message;
  onApproval?: (runId: string, choice: ApprovalChoice) => void;
  approvalSubmitting?: string | null;
  onFork?: (messageId: string) => void;
}) {
  const isUser = message.role === 'user';
  const tools = visibleToolEvents(message);
  const progressLabel = isUser ? '' : runProgressLabel(message);
  const isThinking = !isUser && message.status === 'streaming' && !message.content && tools.length === 0;
  const canFork = !isUser && message.status === 'complete' && Boolean(onFork);
  const canCopyResponse = !isUser && message.status === 'complete' && message.content.trim().length > 0;
  return (
    <div className={cx('group relative min-w-0 overflow-hidden px-0 py-2 text-[16px] leading-7 sm:text-[17px] sm:leading-8', isUser ? 'ml-auto max-w-[82%] rounded-[28px] bg-neutral-100 px-5 py-3 text-neutral-950 sm:max-w-[70%]' : 'mr-auto max-w-[96%] text-neutral-950 sm:max-w-[88%]')}>
      <div className="sr-only">
        <span>{isUser ? branding.userDisplayName : branding.agentDisplayName}</span>
        <span>•</span>
        <span>{message.status}</span>
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {message.attachments.map((attachment) => (
            <figure key={attachment.id} className="overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachment.url ?? attachment.data_url ?? ''} alt={attachment.name} className="h-32 w-full object-cover" />
              <figcaption className="truncate px-2 py-1 text-xs text-neutral-500">{attachment.name}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {!isUser && tools.map((event) => <ToolCard key={event.id} event={event} onApproval={onApproval} approvalSubmitting={approvalSubmitting} />)}
      {isThinking ? (
        <ThinkingBubble label={progressLabel || 'thinking'} />
      ) : (
        <>
          <div className="prose max-w-none text-inherit prose-p:my-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.content}</ReactMarkdown>
          </div>
          <ProgressPill label={progressLabel} />
        </>
      )}
      {isUser && tools.map((event) => <ToolCard key={event.id} event={event} onApproval={onApproval} approvalSubmitting={approvalSubmitting} />)}
      {(canCopyResponse || canFork) && (
        <div className="message-action-row mt-1 flex items-center justify-start gap-1" aria-label="Message actions">
          {canCopyResponse && <MessageCopyButton value={message.content} />}
          {canFork && (
            <button
              type="button"
              onClick={() => onFork?.(message.id)}
              className="message-action-button inline-flex h-7 items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-semibold transition focus:outline-none focus:ring-2"
              aria-label="Fork conversation from this message"
              title="Fork conversation from here"
            >
              <ForkIcon className="h-4 w-4" />
              <span>Fork</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  if (prev.approvalSubmitting !== next.approvalSubmitting) return false;
  if (Boolean(prev.onApproval) !== Boolean(next.onApproval)) return false;
  if (Boolean(prev.onFork) !== Boolean(next.onFork)) return false;
  return messageRenderSignature(prev.message) === messageRenderSignature(next.message);
});

const TranscriptMessageList = memo(function TranscriptMessageList({
  messages,
  hiddenMessageCount,
  onRevealOlder,
  onApproval,
  approvalSubmitting,
  onFork,
}: {
  messages: Message[];
  hiddenMessageCount: number;
  onRevealOlder?: () => void;
  onApproval?: (runId: string, choice: ApprovalChoice) => void;
  approvalSubmitting?: string | null;
  onFork?: (messageId: string) => void;
}) {
  return (
    <>
      {hiddenMessageCount > 0 && onRevealOlder && (
        <div className="mx-auto flex max-w-5xl justify-center pb-1">
          <button
            type="button"
            onClick={onRevealOlder}
            className="rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 shadow-sm transition hover:bg-neutral-50"
          >
            Show {hiddenMessageCount} older message{hiddenMessageCount === 1 ? '' : 's'}
          </button>
        </div>
      )}
      {messages.map((message) => <ChatMessage key={message.id} message={message} onApproval={onApproval} approvalSubmitting={approvalSubmitting} onFork={onFork} />)}
    </>
  );
}, (prev, next) => prev.messages === next.messages && prev.hiddenMessageCount === next.hiddenMessageCount && prev.approvalSubmitting === next.approvalSubmitting && Boolean(prev.onApproval) === Boolean(next.onApproval) && Boolean(prev.onFork) === Boolean(next.onFork));

function TranscriptPanel({ messages, hiddenMessageCount, streamingMessage, onRevealOlder, onApproval, approvalSubmitting, onFork }: TranscriptPanelProps) {
  const combinedMessages = streamingMessage ? [...messages, streamingMessage] : messages;
  const pendingApproval = findPendingApproval(combinedMessages);

  return (
    <>
      {hiddenMessageCount > 0 && onRevealOlder && <TranscriptMessageList messages={messages} hiddenMessageCount={hiddenMessageCount} onRevealOlder={onRevealOlder} onApproval={onApproval} approvalSubmitting={approvalSubmitting} onFork={onFork} />}
      {hiddenMessageCount === 0 && <TranscriptMessageList messages={messages} hiddenMessageCount={0} onApproval={onApproval} approvalSubmitting={approvalSubmitting} onFork={onFork} />}
      {streamingMessage && <ChatMessage message={streamingMessage} onApproval={onApproval} approvalSubmitting={approvalSubmitting} onFork={onFork} />}
      {pendingApproval && onApproval && <div className="sr-only">{pendingApproval.summary}</div>}
    </>
  );
}

export default memo(TranscriptPanel, (prev, next) => prev.messages === next.messages && prev.hiddenMessageCount === next.hiddenMessageCount && prev.streamingMessage === next.streamingMessage && prev.approvalSubmitting === next.approvalSubmitting && Boolean(prev.onApproval) === Boolean(next.onApproval) && Boolean(prev.onFork) === Boolean(next.onFork));
