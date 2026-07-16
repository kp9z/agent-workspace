'use client';

import dynamic from 'next/dynamic';
import { memo, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type TouchEvent } from 'react';
import type { Attachment, ChatSession, Message, Project, ToolEvent, UiStreamEvent } from '@/lib/types';
import { perfMark } from '@/lib/perf';
import type { SessionMessagePatch } from '@/lib/session-events';
import { mergeSessionMessage, mergeSessionSnapshot, mergeSessionSummaryList, sessionSnapshotToSummary, type SessionSummaryLike, type SessionSummaryLikePatch } from '@/lib/session-merge';
import { messageRenderSignature } from '@/lib/message-render-signature';
import { SessionDetailCache } from '@/lib/session-detail-cache';
import { getSidebarSessionNavigation, shouldPrefetchSessionDetail } from '@/lib/session-detail-prefetch';
import { getTranscriptWindow, DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD, DEFAULT_TRANSCRIPT_WINDOW_SIZE, transcriptMessageCount } from '@/lib/transcript-window';
import { SidebarSettingsPanel, type ThemePreference } from '@/components/workspace/sidebar-settings-panel';
import { approvalRunId, findPendingApproval, isPendingApprovalEvent, type ApprovalChoice, type PendingApproval } from '@/components/workspace/transcript-utils';
import { getRunningSessionPollMs, type SessionStreamHealth } from '@/lib/session-stream';
import { buildPinnedSessionNumbers, groupProjectSessions, sortSessionsByPinnedNumber } from '@/lib/sidebar-session-groups';
import { branding } from '@/lib/branding';
import { upsertToolEvent } from '@/lib/tool-events';

type SessionSummary = SessionSummaryLike;
type OutgoingTurn = { content: string; attachments: Attachment[]; sessionId?: string };
type QueuedTurn = OutgoingTurn & { id: string; sessionId: string };
type EffectiveTheme = 'light' | 'dark';
type ContextMenuState = { sessionId: string; title: string; x: number; y: number } | null;
type OptimisticTurn = { sessionId: string; clientTurnId: string; userMessage: Message; assistantMessage: Message };

const LAST_SESSION_KEY = 'hermes-web-ui:last-session-id';
const SESSION_SUMMARIES_CACHE_KEY = 'hermes-web-ui:cache:session-summaries';
const PROJECTS_CACHE_KEY = 'hermes-web-ui:cache:projects';
const ACTIVE_SESSION_CACHE_KEY = 'hermes-web-ui:cache:active-session';
const THEME_KEY = 'hermes-web-ui:theme';
const QUICK_REPLIES_KEY = 'hermes-web-ui:quick-replies';
const QUICK_REPLIES_ENABLED_KEY = 'hermes-web-ui:quick-replies-enabled';
const LEGACY_PINNED_SESSIONS_KEY = 'hermes-web-ui:pinned-session-ids';
const LEGACY_ARCHIVED_SESSIONS_KEY = 'hermes-web-ui:archived-session-ids';
const READ_SESSIONS_KEY = 'hermes-web-ui:read-session-fingerprints';
const COLLAPSED_PROJECTS_KEY = 'hermes-web-ui:collapsed-project-ids';
const DRAFT_SESSION_PREFIX = 'draft-';
const MAX_QUICK_REPLIES = 3;
const DEFAULT_QUICK_REPLIES = ['Looks good', 'Continue', 'Tell me more'];
const MAX_ATTACHMENTS = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_COMPOSER_LINES = 6;
const MAX_QUEUED_TURNS = 10;
const SESSION_DETAIL_CACHE_LIMIT = 12;

function messageClientTurnId(message: Message) {
  return typeof message.metadata?.client_turn_id === 'string' ? message.metadata.client_turn_id : null;
}
const ACTIVE_RUNNING_POLL_MS = 900;
const BACKGROUND_RUNNING_POLL_MS = 2500;
const HIDDEN_RUNNING_POLL_MS = 5000;
const ACTIVITY_PING_MIN_MS = 15_000;
const SIDEBAR_SWIPE_EDGE_WIDTH = 96;
const SIDEBAR_SWIPE_TRIGGER = 54;
const SIDEBAR_SWIPE_VERTICAL_TOLERANCE = 50;
const DESKTOP_SIDEBAR_MEDIA_QUERY = '(min-width: 768px)';

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

const TranscriptPanel = dynamic(() => import('@/components/workspace/transcript-panel'), {
  ssr: false,
  loading: () => (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 md:px-6" aria-hidden="true">
      <div className="h-16 rounded-3xl border border-neutral-200 bg-neutral-50/80" />
      <div className="h-28 rounded-3xl border border-neutral-200 bg-neutral-50/80" />
      <div className="h-20 rounded-3xl border border-neutral-200 bg-neutral-50/80" />
    </div>
  ),
});


function systemTheme(): EffectiveTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function effectiveThemeFor(preference: ThemePreference): EffectiveTheme {
  return preference === 'system' ? systemTheme() : preference;
}

function parseStoredStringArray(key: string) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeQuickReplies(value: unknown) {
  const replies = Array.isArray(value) ? value : DEFAULT_QUICK_REPLIES;
  return replies
    .slice(0, MAX_QUICK_REPLIES)
    .map((reply) => (typeof reply === 'string' ? reply.replace(/\s+/g, ' ').trim().slice(0, 80) : ''));
}

function readJsonCache<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return fallback;
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function writeJsonCache(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cache writes are best-effort; live server state remains authoritative.
  }
}

function readBooleanCache(key: string, fallback = false) {
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return fallback;
    return value === 'true';
  } catch {
    return fallback;
  }
}

function writeBooleanCache(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Cache writes are best-effort; live UI state remains authoritative.
  }
}

type IconProps = { className?: string };
function iconClass(className = 'h-6 w-6') {
  return className;
}

function IconSvg({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function SettingsIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </IconSvg>
  );
}

function RefreshIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M21 12a9 9 0 0 1-15.5 6.2" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8" />
      <path d="M18.5 2.8v3h-3" />
      <path d="M5.5 21.2v-3h3" />
    </IconSvg>
  );
}

function CloseIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </IconSvg>
  );
}

function PlusIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </IconSvg>
  );
}

function MoreIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

function GripIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <circle cx="9" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="17" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17" r="1" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

function MenuIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </IconSvg>
  );
}

function SendIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </IconSvg>
  );
}

function ArrowDownIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M12 5v14" />
      <path d="m5 12 7 7 7-7" />
    </IconSvg>
  );
}

function LoadingDotsIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

function StopIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)} fill="none">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

function ChevronRightIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="m9 18 6-6-6-6" />
    </IconSvg>
  );
}

function PinIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M9 4.5 15.5 11" />
      <path d="m6.5 9 4.5 4.5" />
      <path d="m10.4 5.2-3 3 8.4 8.4 3-3" />
      <path d="m13 16-5 5" />
    </IconSvg>
  );
}

function ArchiveIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M4 7h16" />
      <path d="M6 7v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
      <path d="M8 3h8l2 4H6l2-4Z" />
      <path d="M10 12h4" />
    </IconSvg>
  );
}


function createDraftSession(projectId?: string | null): ChatSession {
  const now = new Date().toISOString();
  const id = `${DRAFT_SESSION_PREFIX}${crypto.randomUUID()}`;
  return {
    id,
    hermes_session_id: `web_${id}`,
    project_id: projectId || null,
    title: 'New session',
    created_at: now,
    updated_at: now,
    runtime_id: 'default',
    continuation_strategy: 'full_transcript',
    status: 'idle',
    messages: [],
  };
}

function sessionReadFingerprint(session: Pick<SessionSummary, 'updated_at' | 'message_count' | 'status'>) {
  return `${session.updated_at}:${session.message_count}:${session.status}`;
}

function isUnreadCompletedSession(session: SessionSummary, activeSessionId: string | null, readFingerprints: Record<string, string>) {
  return session.status === 'idle'
    && session.message_count > 0
    && session.id !== activeSessionId
    && readFingerprints[session.id] !== sessionReadFingerprint(session);
}

function isDraftSessionId(id: string | null | undefined) {
  return Boolean(id?.startsWith(DRAFT_SESSION_PREFIX));
}

function isDraftSession(session: ChatSession | null | undefined) {
  return isDraftSessionId(session?.id);
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

function ApprovalBanner({ approval, onApproval, submittingKey }: { approval: PendingApproval; onApproval: (runId: string, choice: ApprovalChoice) => void; submittingKey?: string | null }) {
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


export default function Home() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<ChatSession | null>(null);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([]);
  const [queuedAutoSend, setQueuedAutoSend] = useState(true);
  const [draggingQueuedTurnId, setDraggingQueuedTurnId] = useState<string | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePreference>('dark');
  const [quickReplies, setQuickReplies] = useState<string[]>(DEFAULT_QUICK_REPLIES);
  const [quickRepliesEnabled, setQuickRepliesEnabled] = useState(false);
  const [settingsSidebarOpen, setSettingsSidebarOpen] = useState(false);
  const [readSessionFingerprints, setReadSessionFingerprints] = useState<Record<string, string>>({});
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [projectPromptDraft, setProjectPromptDraft] = useState('');
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [composerFooterHeight, setComposerFooterHeight] = useState(0);
  const [archivingScope, setArchivingScope] = useState<string | null>(null);
  const [lastArchivedSessionId, setLastArchivedSessionId] = useState<string | null>(null);
  const [expandedTranscriptSessionIds, setExpandedTranscriptSessionIds] = useState<string[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFooterRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastAutoScrollSessionIdRef = useRef<string | null>(null);
  const lastVisibleMessageCountRef = useRef(0);
  const bootstrappedRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const lastArchivedSessionIdRef = useRef<string | null>(null);
  const lastActivityPingAtRef = useRef(0);
  const navigableSessionIdsRef = useRef<string[]>([]);
  const sessionCacheRef = useRef(new SessionDetailCache(SESSION_DETAIL_CACHE_LIMIT));
  const prefetchingSessionIdsRef = useRef<Set<string>>(new Set());
  const firstAssistantUpdateMarkedRef = useRef<Set<string>>(new Set());
  const queueSubmittingRef = useRef(false);
  const steerSubmittingRef = useRef(false);
  const steeringQueuedTurnIdsRef = useRef<Set<string>>(new Set());
  const optimisticTurnRef = useRef<OptimisticTurn | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; startedAtEdge: boolean; handled: boolean } | null>(null);
  const editingTitleRef = useRef(editingTitle);
  const [sessionStreamHealth, setSessionStreamHealth] = useState<SessionStreamHealth>('idle');
  const [sessionStreamReconnectTick, setSessionStreamReconnectTick] = useState(0);
  const refreshInFlightRef = useRef({
    projects: null as Promise<Project[]> | null,
    queue: null as Promise<QueuedTurn[]> | null,
    sessions: null as Promise<SessionSummary[]> | null,
    activeSessions: new Map<string, Promise<ChatSession>>(),
  });
  const [steeringQueuedTurnIds, setSteeringQueuedTurnIds] = useState<Set<string>>(() => new Set());

  const completedMessages = active?.messages || [];
  const transcriptExpansionThreshold = DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD;
  const transcriptWindowSize = DEFAULT_TRANSCRIPT_WINDOW_SIZE;
  const transcriptShouldCollapse = Boolean(active?.id && completedMessages.length > transcriptExpansionThreshold && !expandedTranscriptSessionIds.includes(active.id));
  const transcriptWindow = useMemo(
    () => getTranscriptWindow(completedMessages, { collapsed: transcriptShouldCollapse, collapseThreshold: transcriptExpansionThreshold, windowSize: transcriptWindowSize }),
    [completedMessages, transcriptShouldCollapse, transcriptExpansionThreshold, transcriptWindowSize],
  );
  const transcriptMessages = transcriptWindow.visibleMessages;
  const transcriptMessageTotal = transcriptMessageCount(transcriptMessages, streamingMessage);
  const pendingApproval = useMemo(
    () => findPendingApproval(streamingMessage ? [...transcriptMessages, streamingMessage] : transcriptMessages),
    [transcriptMessages, streamingMessage],
  );

  const activeRunning = active?.status === 'running' || streamingMessage?.status === 'streaming';
  const hasRunningSession = useMemo(() => sessions.some((session) => session.status === 'running'), [sessions]);
  const pinnedSessions = useMemo(
    () => sessions
      .filter((session) => session.pinned_at && !session.archived_at)
      .sort((a, b) => (a.pinned_at || '').localeCompare(b.pinned_at || ''))
      .slice(0, 8),
    [sessions],
  );
  const pinnedSessionNumbers = useMemo(() => buildPinnedSessionNumbers(pinnedSessions), [pinnedSessions]);
  const pinnedSessionIds = useMemo(() => Array.from(pinnedSessionNumbers.keys()), [pinnedSessionNumbers]);
  const pinnedSessionSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
  const collapsedProjectSet = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds]);
  const visibleSessions = useMemo(() => sessions.filter((session) => !session.archived_at), [sessions]);
  const topLevelSessions = useMemo(() => visibleSessions.filter((session) => !session.project_id), [visibleSessions]);
  const pinnedTopLevelSessions = useMemo(() => pinnedSessions.filter((session) => !session.project_id), [pinnedSessions]);
  const unpinnedSessions = useMemo(() => topLevelSessions.filter((session) => !pinnedSessionSet.has(session.id)), [topLevelSessions, pinnedSessionSet]);
  const projectSessionsById = useMemo(() => {
    const grouped = groupProjectSessions(visibleSessions);
    for (const projectSessions of grouped.values()) {
      sortSessionsByPinnedNumber(projectSessions, pinnedSessionNumbers);
    }
    return grouped;
  }, [visibleSessions, pinnedSessionNumbers]);
  const activeProject = useMemo(() => projects.find((project) => project.id === active?.project_id) || null, [active?.project_id, projects]);
  const mentionMatch = input.match(/^@(\S*)$/);
  const mentionProjectSuggestions = useMemo(() => {
    const query = mentionMatch?.[1]?.toLowerCase() || '';
    if (!mentionMatch) return [];
    return projects.filter((project) => project.slug.startsWith(query) || project.name.toLowerCase().startsWith(query)).slice(0, 5);
  }, [projects, mentionMatch]);

  useEffect(() => {
    perfMark('boot:mounted');
  }, []);

  useEffect(() => {
    if (active && composerRef.current) perfMark('boot:composer-usable', { session_id: active.id });
  }, [active?.id]);

  useEffect(() => {
    const updateVisibility = () => {
      const visible = document.visibilityState === 'visible';
      setDocumentVisible(visible);
      if (visible) pingWorkspaceActivity(activeIdRef.current, true);
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('pageshow', updateVisibility);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('pageshow', updateVisibility);
    };
  }, []);

  useEffect(() => {
    const recordInteraction = () => pingWorkspaceActivity(activeIdRef.current);
    window.addEventListener('focus', recordInteraction);
    window.addEventListener('pointerdown', recordInteraction, { passive: true });
    window.addEventListener('keydown', recordInteraction);
    return () => {
      window.removeEventListener('focus', recordInteraction);
      window.removeEventListener('pointerdown', recordInteraction);
      window.removeEventListener('keydown', recordInteraction);
    };
  }, []);

  useEffect(() => {
    activeIdRef.current = active?.id || null;
    activeProjectIdRef.current = active?.project_id || null;
  }, [active?.id, active?.project_id]);

  useEffect(() => {
    editingTitleRef.current = editingTitle;
  }, [editingTitle]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_KEY);
    const nextTheme: ThemePreference = storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system' ? storedTheme : 'dark';
    setTheme(nextTheme);
    document.documentElement.dataset.themePreference = nextTheme;
    document.documentElement.dataset.theme = effectiveThemeFor(nextTheme);

    const storedQuickReplies = readJsonCache<string[]>(QUICK_REPLIES_KEY, DEFAULT_QUICK_REPLIES);
    setQuickReplies(normalizeQuickReplies(storedQuickReplies));
    setQuickRepliesEnabled(readBooleanCache(QUICK_REPLIES_ENABLED_KEY, false));
  }, []);

  useEffect(() => {
    writeJsonCache(QUICK_REPLIES_KEY, normalizeQuickReplies(quickReplies));
  }, [quickReplies]);

  useEffect(() => {
    writeBooleanCache(QUICK_REPLIES_ENABLED_KEY, quickRepliesEnabled);
  }, [quickRepliesEnabled]);

  useEffect(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(READ_SESSIONS_KEY) || '{}');
      setReadSessionFingerprints(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {});
    } catch {
      setReadSessionFingerprints({});
    }
  }, []);

  useEffect(() => {
    setCollapsedProjectIds(parseStoredStringArray(COLLAPSED_PROJECTS_KEY));
  }, []);

  useEffect(() => {
    if (sessions.length === 0) return;
    if (window.localStorage.getItem(READ_SESSIONS_KEY) !== null) return;
    const seeded = Object.fromEntries(sessions.map((session) => [session.id, sessionReadFingerprint(session)]));
    setReadSessionFingerprints(seeded);
    persistReadSessionFingerprints(seeded);
  }, [sessions]);

  useEffect(() => {
    if (!active || document.visibilityState !== 'visible') return;
    markSessionRead(active);
  }, [active?.id, active?.updated_at, active?.status, active?.messages.length]);

  useEffect(() => {
    const applyTheme = () => {
      document.documentElement.dataset.themePreference = theme;
      document.documentElement.dataset.theme = effectiveThemeFor(theme);
      window.localStorage.setItem(THEME_KEY, theme);
    };
    applyTheme();
    if (theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', applyTheme);
    return () => query.removeEventListener('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    if (!sidebarOpen) setSettingsSidebarOpen(false);
  }, [sidebarOpen]);

  useEffect(() => {
    const desktopQuery = window.matchMedia(DESKTOP_SIDEBAR_MEDIA_QUERY);
    if (desktopQuery.matches) setSidebarOpen(true);
  }, []);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;

    const styles = window.getComputedStyle(composer);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const border = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    const maxHeight = lineHeight * MAX_COMPOSER_LINES + padding + border;

    composer.style.height = 'auto';
    const nextHeight = Math.min(composer.scrollHeight, maxHeight);
    composer.style.height = `${nextHeight}px`;
    composer.style.overflowY = composer.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [input]);

  function refreshApp() {
    window.location.reload();
  }

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjectIds((current) => {
      const next = current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId];
      writeJsonCache(COLLAPSED_PROJECTS_KEY, next);
      return next;
    });
  }

  function sessionIdFromUrl() {
    const raw = new URLSearchParams(window.location.search).get('session');
    return raw && !isDraftSessionId(raw) ? raw : null;
  }

  function updateSessionUrl(id: string) {
    if (isDraftSessionId(id)) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('session') === id) return;
    url.searchParams.set('session', id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function pingWorkspaceActivity(sessionId = activeIdRef.current, force = false) {
    const now = Date.now();
    if (!force && now - lastActivityPingAtRef.current < ACTIVITY_PING_MIN_MS) return;
    lastActivityPingAtRef.current = now;
    fetch('/api/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId || null }),
      keepalive: true,
    }).catch(() => undefined);
  }

  useEffect(() => {
    const root = document.documentElement;

    function updateViewportHeight() {
      root.style.setProperty('--app-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
    }

    updateViewportHeight();
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateViewportHeight);
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);

    return () => {
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateViewportHeight);
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', updateViewportHeight);
      root.style.removeProperty('--app-viewport-height');
    };
  }, []);

  function handleAppTouchStart(event: TouchEvent<HTMLElement>) {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      startedAtEdge: touch.clientX <= SIDEBAR_SWIPE_EDGE_WIDTH,
      handled: false,
    };
  }

  function handleAppTouchMove(event: TouchEvent<HTMLElement>) {
    const start = touchStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch || start.handled) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.5;
    if (!mostlyHorizontal || Math.abs(deltaY) > SIDEBAR_SWIPE_VERTICAL_TOLERANCE || Math.abs(deltaX) < SIDEBAR_SWIPE_TRIGGER) return;

    if (!sidebarOpen && start.startedAtEdge && deltaX > 0) {
      event.preventDefault();
      start.handled = true;
      setSidebarOpen(true);
      return;
    }

    if (sidebarOpen && deltaX < 0) {
      event.preventDefault();
      start.handled = true;
      setSidebarOpen(false);
    }
  }

  function handleAppTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || start.handled) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.5;
    if (!mostlyHorizontal || Math.abs(deltaY) > SIDEBAR_SWIPE_VERTICAL_TOLERANCE || Math.abs(deltaX) < SIDEBAR_SWIPE_TRIGGER) return;

    if (!sidebarOpen && start.startedAtEdge && deltaX > 0) {
      setSidebarOpen(true);
      return;
    }

    if (sidebarOpen && deltaX < 0) {
      setSidebarOpen(false);
    }
  }

  function transcriptIsNearBottom(transcript: HTMLDivElement) {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  }

  function handleTranscriptScroll() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const nearBottom = transcriptIsNearBottom(transcript);
    shouldStickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  }

  function scrollTranscriptToBottom(behavior: ScrollBehavior = 'smooth') {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    shouldStickToBottomRef.current = true;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    setShowJumpToBottom(false);
  }


  function rememberSession(id: string) {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LAST_SESSION_KEY, id);
    }
  }

  function visibleSessionIdSet(nextSessions = sessions) {
    return new Set(nextSessions.filter((session) => !session.archived_at).map((session) => session.id));
  }

  function pruneSessionDetailCache(nextSessions = sessions) {
    const visibleIds = visibleSessionIdSet(nextSessions);
    sessionCacheRef.current.prune(visibleIds);
    const cachedActive = readJsonCache<ChatSession | null>(ACTIVE_SESSION_CACHE_KEY, null);
    if (cachedActive && !visibleIds.has(cachedActive.id)) window.localStorage.removeItem(ACTIVE_SESSION_CACHE_KEY);
    return visibleIds;
  }

  function persistSessionSummaries(nextSessions: SessionSummary[]) {
    writeJsonCache(SESSION_SUMMARIES_CACHE_KEY, nextSessions.filter((session) => !session.archived_at));
  }

  function persistProjects(nextProjects: Project[]) {
    writeJsonCache(PROJECTS_CACHE_KEY, nextProjects);
  }

  function persistActiveSession(session: ChatSession) {
    if (session.archived_at) return;
    writeJsonCache(ACTIVE_SESSION_CACHE_KEY, session);
  }

  function hydrateFromClientCache() {
    const cachedSessions = readJsonCache<SessionSummary[]>(SESSION_SUMMARIES_CACHE_KEY, []);
    if (cachedSessions.length > 0) {
      setSessions(cachedSessions.filter((session) => !session.archived_at));
      perfMark('cache:summaries-visible', { count: cachedSessions.length });
    }

    const cachedProjects = readJsonCache<Project[]>(PROJECTS_CACHE_KEY, []);
    if (cachedProjects.length > 0) {
      setProjects(cachedProjects);
      perfMark('cache:projects-visible', { count: cachedProjects.length });
    }

    const cachedActive = readJsonCache<ChatSession | null>(ACTIVE_SESSION_CACHE_KEY, null);
    const cachedVisibleIds = visibleSessionIdSet(cachedSessions);
    if (cachedActive && (cachedVisibleIds.size === 0 || cachedVisibleIds.has(cachedActive.id))) {
      sessionCacheRef.current.set(cachedActive);
      applyLoadedSession(cachedActive);
      perfMark('cache:active-session-visible', { session_id: cachedActive.id, message_count: cachedActive.messages.length });
    }

    return { cachedSessions, cachedProjects, cachedActive };
  }

  function persistReadSessionFingerprints(next: Record<string, string>) {
    window.localStorage.setItem(READ_SESSIONS_KEY, JSON.stringify(next));
  }

  function markSessionRead(session: Pick<ChatSession, 'id' | 'updated_at' | 'status' | 'messages'>) {
    if (session.status !== 'idle') return;
    const fingerprint = sessionReadFingerprint({ updated_at: session.updated_at, status: session.status, message_count: session.messages.length });
    setReadSessionFingerprints((current) => {
      if (current[session.id] === fingerprint) return current;
      const next = { ...current, [session.id]: fingerprint };
      persistReadSessionFingerprints(next);
      return next;
    });
  }

  function applySessionMetadataUpdate(updated: ChatSession) {
    if (updated.archived_at) sessionCacheRef.current.delete(updated.id);
    else sessionCacheRef.current.set(updated);
    setSessions((current) => {
      const next = current.map((session) => (session.id === updated.id ? {
        ...session,
        pinned_at: updated.pinned_at || null,
        archived_at: updated.archived_at || null,
      } : session));
      persistSessionSummaries(next);
      return next;
    });
    setActive((current) => (current?.id === updated.id ? { ...current, pinned_at: updated.pinned_at || null, archived_at: updated.archived_at || null } : current));
  }

  async function updateSessionMetadata(id: string, metadata: { pinned?: boolean; archived?: boolean }) {
    const res = await fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    if (!res.ok) throw new Error(await res.text());
    const updated = (await res.json()) as ChatSession;
    if (updated.archived_at) {
      sessionCacheRef.current.delete(updated.id);
      window.localStorage.removeItem(ACTIVE_SESSION_CACHE_KEY);
    }
    applySessionMetadataUpdate(updated);
    return updated;
  }

  async function pinSession(id: string) {
    await updateSessionMetadata(id, { pinned: true });
    setContextMenu(null);
  }

  async function unpinSession(id: string) {
    await updateSessionMetadata(id, { pinned: false });
    setContextMenu(null);
  }

  async function togglePinnedSession(id: string) {
    if (pinnedSessionSet.has(id)) {
      await unpinSession(id);
    } else {
      await pinSession(id);
    }
  }

  async function archiveSession(id: string) {
    const shouldSelectReplacement = activeIdRef.current === id;
    const navigationOrder = navigableSessionIdsRef.current;
    const currentIndex = navigationOrder.indexOf(id);
    const remainingSessionIds = navigationOrder.filter((sessionId) => sessionId !== id);
    const replacementSessionId = shouldSelectReplacement
      ? remainingSessionIds[currentIndex] || remainingSessionIds[currentIndex - 1] || null
      : null;

    await updateSessionMetadata(id, { archived: true });
    lastArchivedSessionIdRef.current = id;
    setLastArchivedSessionId(id);
    setContextMenu(null);
    if (shouldSelectReplacement) {
      if (replacementSessionId) await openSession(replacementSessionId);
      else await newSession();
    }
  }

  async function undoLastArchive() {
    const archivedId = lastArchivedSessionIdRef.current || lastArchivedSessionId;
    if (!archivedId) return;
    const restored = await updateSessionMetadata(archivedId, { archived: false });
    lastArchivedSessionIdRef.current = null;
    setLastArchivedSessionId(null);
    await loadSession(restored.id);
    focusComposerSoon();
  }

  async function archiveSessionsInScope(projectId: string | null, label: string) {
    const scopeKey = projectId || 'projectless';
    if (archivingScope) return;
    const sessionsInScope = projectId ? (projectSessionsById.get(projectId) || []) : topLevelSessions;
    if (sessionsInScope.length === 0) return;
    const confirmed = window.confirm(`Archive ${sessionsInScope.length} chat${sessionsInScope.length === 1 ? '' : 's'} in ${label}?`);
    if (!confirmed) return;

    setArchivingScope(scopeKey);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectId ? { archived: true, project_id: projectId } : { archived: true, scope: 'projectless' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { sessions: SessionSummary[] };
      sessionCacheRef.current.clear();
      window.localStorage.removeItem(ACTIVE_SESSION_CACHE_KEY);
      setSessions(data.sessions);
      persistSessionSummaries(data.sessions);
      if (activeIdRef.current && sessionsInScope.some((session) => session.id === activeIdRef.current)) await newSession(projectId);
    } finally {
      setArchivingScope(null);
    }
  }

  function sessionDotClass(session: SessionSummary) {
    if (session.status === 'failed') return 'bg-red-500 opacity-100 group-hover:opacity-100';
    if (session.status === 'running') return 'bg-amber-400 opacity-100 group-hover:opacity-100';
    if (isUnreadCompletedSession(session, active?.id || null, readSessionFingerprints)) return 'bg-sky-500 opacity-100 group-hover:opacity-100';
    return null;
  }

  function renderSessionDot(session: SessionSummary, className: string) {
    const dotClass = sessionDotClass(session);
    if (!dotClass) return null;
    return <span className={cx(className, dotClass)} aria-hidden="true" />;
  }

  function renderSessionActions(session: SessionSummary, size: 'normal' | 'compact' = 'normal') {
    const pinned = pinnedSessionSet.has(session.id);
    const iconSize = size === 'compact' ? 'h-6 w-6 rounded-lg' : 'h-7 w-7 rounded-xl';
    return (
      <div className="chat-row-actions ml-1 hidden shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 md:flex" aria-label={`Actions for ${session.title}`}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            togglePinnedSession(session.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
          }}
          className={cx('chat-row-action-button inline-flex items-center justify-center transition focus:outline-none focus:ring-2', iconSize, pinned && 'opacity-100')}
          aria-label={pinned ? `Unpin ${session.title}` : `Pin ${session.title}`}
          title={pinned ? 'Unpin chat' : 'Pin chat'}
        >
          <PinIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            archiveSession(session.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
          }}
          className={cx('chat-row-action-button inline-flex items-center justify-center transition focus:outline-none focus:ring-2', iconSize)}
          aria-label={`Archive ${session.title}`}
          title="Archive chat"
        >
          <ArchiveIcon className="h-4 w-4" />
        </button>
      </div>
    );
  }

  function openSessionContextMenu(event: MouseEvent, session: SessionSummary) {
    event.preventDefault();
    setContextMenu({ sessionId: session.id, title: session.title, x: event.clientX, y: event.clientY });
  }

  async function refreshQueue(source = 'manual') {
    const inFlight = refreshInFlightRef.current.queue;
    if (inFlight) return inFlight;
    const promise = (async () => {
      perfMark('queue:fetch-start', { source });
      const res = await fetch('/api/queue');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const nextQueue = Array.isArray(data.queue) ? (data.queue as QueuedTurn[]) : [];
      setQueuedTurns(nextQueue);
      setQueuedAutoSend(nextQueue.length > 0);
      perfMark('queue:fetch-end', { source, count: nextQueue.length });
      return nextQueue;
    })();
    refreshInFlightRef.current.queue = promise;
    try {
      return await promise;
    } finally {
      if (refreshInFlightRef.current.queue === promise) refreshInFlightRef.current.queue = null;
    }
  }

  async function refreshProjects(source = 'manual') {
    const inFlight = refreshInFlightRef.current.projects;
    if (inFlight) return inFlight;
    const promise = (async () => {
      perfMark('projects:fetch-start', { source });
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const nextProjects = Array.isArray(data.projects) ? (data.projects as Project[]) : [];
      setProjects(nextProjects);
      persistProjects(nextProjects);
      perfMark('projects:fetch-end', { source, count: nextProjects.length });
      return nextProjects;
    })();
    refreshInFlightRef.current.projects = promise;
    try {
      return await promise;
    } finally {
      if (refreshInFlightRef.current.projects === promise) refreshInFlightRef.current.projects = null;
    }
  }

  async function refreshSessions(source = 'manual') {
    const inFlight = refreshInFlightRef.current.sessions;
    if (inFlight) return inFlight;
    const promise = (async () => {
      perfMark('sessions:fetch-start', { source });
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const nextSessions = Array.isArray(data.sessions) ? (data.sessions as SessionSummary[]) : [];
      const visibleSessionIds = pruneSessionDetailCache(nextSessions);
      setSessions(nextSessions);
      persistSessionSummaries(nextSessions);
      perfMark('sessions:fetch-end', { source, count: nextSessions.length, visible_count: visibleSessionIds.size });
      return nextSessions;
    })();
    refreshInFlightRef.current.sessions = promise;
    try {
      return await promise;
    } finally {
      if (refreshInFlightRef.current.sessions === promise) refreshInFlightRef.current.sessions = null;
    }
  }

  async function reconcileActiveSession() {
    setSending(false);
    setStreamingMessage(null);
    await refreshSessions('reconcile');
    await refreshQueue('reconcile').catch(() => undefined);
    const activeId = activeIdRef.current;
    if (activeId && !isDraftSessionId(activeId)) await loadSession(activeId, { preserveQueue: true, forceRefresh: true, source: 'reconcile' });
  }

  function applyLoadedSession(session: ChatSession) {
    activeProjectIdRef.current = session.project_id || null;
    sessionCacheRef.current.set(session);

    let sessionToApply = session;
    const optimistic = optimisticTurnRef.current;
    if (optimistic?.sessionId === session.id) {
      const hasPersistedAssistant = session.messages.some((message) => message.role === 'assistant' && messageClientTurnId(message) === optimistic.clientTurnId);
      if (hasPersistedAssistant) {
        optimisticTurnRef.current = null;
      } else {
        const hasUserMessage = session.messages.some((message) => message.role === 'user' && messageClientTurnId(message) === optimistic.clientTurnId);
        sessionToApply = {
          ...session,
          status: 'running',
          messages: hasUserMessage ? session.messages : [...session.messages, optimistic.userMessage],
        };
        setStreamingMessage(optimistic.assistantMessage);
      }
    }

    setActive(sessionToApply);
    setTitleDraft(sessionToApply.title);
    setEditingTitle(false);
    if (optimisticTurnRef.current?.sessionId !== session.id) setStreamingMessage(null);
    setApprovalSubmitting(null);
    rememberSession(session.id);
    updateSessionUrl(session.id);
    pingWorkspaceActivity(session.id, true);
    persistActiveSession(sessionToApply);
  }

  async function prefetchSession(id: string) {
    if (!shouldPrefetchSessionDetail(id, {
      cached: sessionCacheRef.current.has(id),
      prefetching: prefetchingSessionIdsRef.current.has(id),
      isDraft: isDraftSessionId(id),
    })) return;
    prefetchingSessionIdsRef.current.add(id);
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) return;
      const session = (await res.json()) as ChatSession;
      sessionCacheRef.current.set(session);
      perfMark('session:prefetched', { session_id: session.id, message_count: session.messages.length });
    } finally {
      prefetchingSessionIdsRef.current.delete(id);
    }
  }

  async function fetchSession(id: string, source = 'manual') {
    perfMark('session:fetch-start', { source, session_id: id });
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) throw new Error('Could not load session');
    const session = (await res.json()) as ChatSession;
    perfMark('session:fetch-end', { source, session_id: id, message_count: session.messages.length, status: session.status });
    return session;
  }

  async function loadSession(id: string, options?: { preserveQueue?: boolean; forceRefresh?: boolean; source?: string }): Promise<ChatSession> {
    if (isDraftSessionId(id)) return undefined as never;
    const source = options?.source || 'manual';
    const inFlight = refreshInFlightRef.current.activeSessions.get(id);
    if (inFlight) return inFlight;
    const promise = (async () => {
      perfMark('session:load-start', { source, session_id: id, force_refresh: Boolean(options?.forceRefresh) });
      activeIdRef.current = id;
      const cached = sessionCacheRef.current.get(id);
      if (cached && !options?.forceRefresh) {
        applyLoadedSession(cached);
        perfMark('session:cached-visible', { source, session_id: id, message_count: cached.messages.length });
        fetchSession(id, `${source}:background-refresh`)
          .then((session) => {
            if (activeIdRef.current === id) {
              applyLoadedSession(session);
              perfMark('session:rendered', { source: `${source}:background-refresh`, session_id: id, message_count: session.messages.length });
            } else sessionCacheRef.current.set(session);
          })
          .catch(() => undefined);
        return cached;
      }

      let session: ChatSession;
      try {
        session = await fetchSession(id, source);
      } catch (err) {
        if (activeIdRef.current === id && !cached) activeIdRef.current = null;
        throw err;
      }
      if (activeIdRef.current !== id) return session;
      applyLoadedSession(session);
      perfMark('session:rendered', { source, session_id: id, message_count: session.messages.length });
      return session;
    })();
    refreshInFlightRef.current.activeSessions.set(id, promise);
    try {
      return await promise;
    } finally {
      if (refreshInFlightRef.current.activeSessions.get(id) === promise) {
        refreshInFlightRef.current.activeSessions.delete(id);
      }
    }
  }

  function shouldCollapseSidebarOnChatOpen() {
    return window.matchMedia('(max-width: 767px)').matches;
  }

  async function openSession(id: string) {
    if (shouldCollapseSidebarOnChatOpen()) setSidebarOpen(false);
    await loadSession(id, { source: 'chat-switch' });
    focusComposerSoon();
  }

  function visibleSessionNavButtons(root: ParentNode = document) {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('[data-session-nav="true"]'))
      .filter((button) => !button.disabled && button.offsetParent !== null);
  }

  function navigateSidebarSession(direction: 1 | -1, focusedIndex = -1) {
    const navigation = getSidebarSessionNavigation(navigableSessionIds, focusedIndex >= 0 ? focusedIndex : (activeIdRef.current ? navigableSessionIds.indexOf(activeIdRef.current) : -1), direction);
    if (!navigation.sessionId) return false;

    openSession(navigation.sessionId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    if (navigation.lookaheadSessionId && navigation.lookaheadSessionId !== navigation.sessionId) prefetchSession(navigation.lookaheadSessionId).catch(() => undefined);
    focusComposerSoon();
    return true;
  }

  function handleSidebarKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('[data-session-nav="true"]')) return;

    const buttons = visibleSessionNavButtons(event.currentTarget);
    if (buttons.length === 0) return;

    const activeElement = document.activeElement as HTMLElement | null;
    const focusedIndex = activeElement ? buttons.findIndex((button) => button === activeElement || button.contains(activeElement)) : -1;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    event.preventDefault();
    navigateSidebarSession(direction, focusedIndex);
  }

  function focusComposerSoon() {
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function revealOlderTranscriptMessages() {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    setExpandedTranscriptSessionIds((current) => (current.includes(sessionId) ? current : [...current, sessionId]));
  }

  async function newSession(projectId?: string | null) {
    const session = createDraftSession(projectId === undefined ? activeProjectIdRef.current : projectId);
    activeIdRef.current = session.id;
    activeProjectIdRef.current = session.project_id || null;
    setActive(session);
    setTitleDraft(session.title);
    setEditingTitle(false);
    setStreamingMessage(null);
    setInput('');
    setAttachments([]);
    setApprovalSubmitting(null);
    setError(null);
    focusComposerSoon();
  }

  async function forkFromMessage(messageId: string) {
    if (!active || isDraftSession(active)) return;
    setError(null);
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fork_from_session_id: active.id, fork_point_message_id: messageId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const forked = (await res.json()) as ChatSession;
    activeIdRef.current = forked.id;
    setActive(forked);
    persistActiveSession(forked);
    setTitleDraft(forked.title);
    setEditingTitle(false);
    setStreamingMessage(null);
    setInput('');
    setAttachments([]);
    setApprovalSubmitting(null);
    setSidebarOpen(false);
    activeProjectIdRef.current = forked.project_id || null;
    rememberSession(forked.id);
    await refreshSessions();
    shouldStickToBottomRef.current = true;
    focusComposerSoon();
  }

  useEffect(() => {
    function handleGlobalShortcut(event: globalThis.KeyboardEvent) {
      const usesPrimaryModifier = event.metaKey || event.ctrlKey;
      if (!usesPrimaryModifier || event.altKey) return;

      const key = event.key.toLowerCase();
      const isToggleSidebarShortcut = !event.shiftKey && key === 'b';
      if (isToggleSidebarShortcut) {
        event.preventDefault();
        setSidebarOpen((value) => !value);
        return;
      }

      const isNewChatShortcut = key === 'o';
      if (isNewChatShortcut) {
        event.preventDefault();
        newSession(event.shiftKey ? null : undefined);
        return;
      }

      const isToggleActivePinShortcut = event.shiftKey && key === 'p';
      if (isToggleActivePinShortcut) {
        const activeId = activeIdRef.current;
        if (!activeId || isDraftSessionId(activeId)) return;
        event.preventDefault();
        togglePinnedSession(activeId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        return;
      }

      const isArchiveActiveShortcut = !event.shiftKey && event.key === 'Backspace';
      if (isArchiveActiveShortcut) {
        const activeId = activeIdRef.current;
        if (!activeId || isDraftSessionId(activeId)) return;
        event.preventDefault();
        archiveSession(activeId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        return;
      }

      const isUndoArchiveShortcut = event.shiftKey && event.key === 'Backspace';
      if (isUndoArchiveShortcut && lastArchivedSessionIdRef.current) {
        event.preventDefault();
        undoLastArchive().catch((err) => setError(err instanceof Error ? err.message : String(err)));
        return;
      }

      const isChatNavigationShortcut = !event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp');
      if (isChatNavigationShortcut) {
        event.preventDefault();
        navigateSidebarSession(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (event.shiftKey) return;
      const pinnedIndex = /^[1-8]$/.test(event.key) ? Number(event.key) - 1 : -1;
      const pinnedSessionId = pinnedIndex >= 0 ? pinnedSessionIds[pinnedIndex] : undefined;
      if (!pinnedSessionId) return;
      event.preventDefault();
      openSession(pinnedSessionId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
  }, [lastArchivedSessionId, pinnedSessionIds]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  function projectForMentionCommand(text: string) {
    const match = text.trimStart().match(/^@(\S+)(?:\s+|$)([\s\S]*)$/);
    if (!match) return null;
    const slug = match[1].toLowerCase();
    const project = projects.find((item) => item.slug === slug || item.name.toLowerCase() === slug);
    if (!project) return null;
    return { project, content: match[2].trimStart() };
  }

  function openProjectEditor(project?: Project) {
    setEditingProject(project || { id: '', name: '', slug: '', system_prompt: '', created_at: '', updated_at: '' });
    setProjectNameDraft(project?.name || '');
    setProjectPromptDraft(project?.system_prompt || '');
  }

  async function saveProject() {
    const name = projectNameDraft.trim();
    if (!name) return;
    const res = await fetch(editingProject?.id ? `/api/projects/${editingProject.id}` : '/api/projects', {
      method: editingProject?.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, system_prompt: projectPromptDraft }),
    });
    if (!res.ok) throw new Error(await res.text());
    const project = (await res.json()) as Project;
    setEditingProject(null);
    setProjectNameDraft('');
    setProjectPromptDraft('');
    await refreshProjects();
    if (!active) await newSession(project.id);
  }

  async function deleteEditingProject() {
    if (!editingProject?.id) return;
    const projectSessionCount = projectSessionsById.get(editingProject.id)?.length || 0;
    const confirmed = window.confirm(
      `Delete @${editingProject.slug}? This permanently deletes the project${projectSessionCount > 0 ? ` and ${projectSessionCount} related chat${projectSessionCount === 1 ? '' : 's'}` : ''}.`,
    );
    if (!confirmed) return;

    const deletedProjectId = editingProject.id;
    const deletedSessionIds = projectSessionsById.get(deletedProjectId)?.map((session) => session.id) || [];
    const res = await fetch(`/api/projects/${deletedProjectId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());

    setEditingProject(null);
    setProjectNameDraft('');
    setProjectPromptDraft('');
    setProjects((current) => current.filter((project) => project.id !== deletedProjectId));
    setSessions((current) => current.filter((session) => session.project_id !== deletedProjectId));
    if (active?.project_id === deletedProjectId || (active?.id && deletedSessionIds.includes(active.id))) {
      await newSession(null);
    }
    await Promise.all([refreshProjects(), refreshSessions()]);
  }

  async function saveSessionTitle() {
    if (!active) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === active.title) {
      setEditingTitle(false);
      setTitleDraft(active.title);
      return;
    }
    if (isDraftSession(active)) {
      const updated = { ...active, title: nextTitle, updated_at: new Date().toISOString() };
      setActive(updated);
      setTitleDraft(updated.title);
      setEditingTitle(false);
      return;
    }
    const res = await fetch(`/api/sessions/${active.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: nextTitle }),
    });
    if (!res.ok) throw new Error(await res.text());
    const updated = (await res.json()) as ChatSession;
    setActive(updated);
    persistActiveSession(updated);
    setTitleDraft(updated.title);
    setEditingTitle(false);
    setSessions((current) => {
      const next = current.map((session) => (session.id === updated.id ? { ...session, title: updated.title, updated_at: updated.updated_at } : session));
      persistSessionSummaries(next);
      return next;
    });
    await refreshSessions();
  }

  useEffect(() => {
    const boot = async () => {
      const cached = hydrateFromClientCache();
      const [sessionsList] = await Promise.all([refreshSessions('boot'), refreshProjects('boot').catch(() => cached.cachedProjects)]);
      await refreshQueue('boot').catch(() => undefined);
      if (bootstrappedRef.current) return;
      bootstrappedRef.current = true;

      let bootSessions = sessionsList;
      const legacyPinned = parseStoredStringArray(LEGACY_PINNED_SESSIONS_KEY).slice(0, 8);
      const legacyArchived = parseStoredStringArray(LEGACY_ARCHIVED_SESSIONS_KEY);
      const legacySessionIds = new Set([...legacyPinned, ...legacyArchived]);
      if (legacySessionIds.size > 0) {
        const existingIds = new Set(sessionsList.map((session) => session.id));
        await Promise.all([
          ...legacyPinned.filter((id) => existingIds.has(id)).map((id) => updateSessionMetadata(id, { pinned: true }).catch(() => undefined)),
          ...legacyArchived.filter((id) => existingIds.has(id)).map((id) => updateSessionMetadata(id, { archived: true }).catch(() => undefined)),
        ]);
        window.localStorage.removeItem(LEGACY_PINNED_SESSIONS_KEY);
        window.localStorage.removeItem(LEGACY_ARCHIVED_SESSIONS_KEY);
        bootSessions = await refreshSessions('boot:legacy-metadata');
      }

      const storedId = window.localStorage.getItem(LAST_SESSION_KEY);
      const linkedId = sessionIdFromUrl();
      const visibleSessionsList = bootSessions.filter((session) => !session.archived_at);
      const selectedId = linkedId && visibleSessionsList.some((session) => session.id === linkedId)
        ? linkedId
        : storedId && visibleSessionsList.some((session) => session.id === storedId)
          ? storedId
          : visibleSessionsList[0]?.id;
      if (selectedId) {
        await loadSession(selectedId, { source: 'boot' });
        perfMark('boot:active-session-loaded', { session_id: selectedId });
      }
    };

    boot().catch(() => undefined);
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    const activeSessionId = active?.id || null;
    const sessionChanged = lastAutoScrollSessionIdRef.current !== activeSessionId;
    const messageCountChanged = lastVisibleMessageCountRef.current !== transcriptMessageTotal;
    lastAutoScrollSessionIdRef.current = activeSessionId;
    lastVisibleMessageCountRef.current = transcriptMessageTotal;

    if (sessionChanged) {
      shouldStickToBottomRef.current = true;
    }

    if (!sessionChanged && !messageCountChanged) return;
    if (!shouldStickToBottomRef.current) return;

    const jumpToBottom = () => {
      transcript.scrollTop = transcript.scrollHeight;
      shouldStickToBottomRef.current = true;
      setShowJumpToBottom(false);
    };

    jumpToBottom();
    const frame = window.requestAnimationFrame(jumpToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [active?.id, transcriptMessageTotal]);

  useEffect(() => {
    const footer = composerFooterRef.current;
    if (!footer) return;

    const updateFooterHeight = () => setComposerFooterHeight(footer.getBoundingClientRect().height);
    updateFooterHeight();
    const observer = new ResizeObserver(updateFooterHeight);
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const hasRunning = hasRunningSession || activeRunning;
    const pollMs = getRunningSessionPollMs({
      hasRunningSession: hasRunning,
      activeRunning,
      documentVisible,
      streamHealth: sessionStreamHealth,
    });
    if (!hasRunning || pollMs === null) return;

    const pollRunningState = () => {
      perfMark('background:poll', { active_running: activeRunning, visible: documentVisible, poll_ms: pollMs, stream_health: sessionStreamHealth });
      refreshSessions('poll').catch(() => undefined);
      const activeId = activeIdRef.current;
      if (activeRunning && activeId && !isDraftSessionId(activeId)) {
        loadSession(activeId, { preserveQueue: true, forceRefresh: true, source: 'poll:active-running' }).catch(() => undefined);
      }
    };

    pollRunningState();
    const timer = window.setInterval(pollRunningState, pollMs);
    return () => window.clearInterval(timer);
  }, [hasRunningSession, activeRunning, documentVisible, sessionStreamHealth]);

  useEffect(() => {
    const activeSessionId = active?.id;
    if (!activeSessionId || isDraftSessionId(activeSessionId) || !activeRunning) {
      setSessionStreamHealth('idle');
      return;
    }

    const sessionId = activeSessionId;
    let closed = false;
    let reconnectTimer: number | null = null;
    const source = new EventSource(`/api/sessions/${sessionId}/events`);
    perfMark('background:eventsource-open', { session_id: sessionId });
    setSessionStreamHealth('connecting');

    const syncActiveSession = (next: ChatSession) => {
      if (activeIdRef.current !== next.id) return;
      const hasAssistantUpdate = next.messages.some((message) => message.role === 'assistant' && (message.content.trim() || (message.tool_events || []).length > 0));
      if (hasAssistantUpdate && !firstAssistantUpdateMarkedRef.current.has(next.id)) {
        firstAssistantUpdateMarkedRef.current.add(next.id);
        perfMark('send:first-assistant-update', { session_id: next.id, status: next.status });
      }
      sessionCacheRef.current.set(next);
      persistActiveSession(next);
      if (!editingTitleRef.current) setTitleDraft(next.title);
      setStreamingMessage(null);
      let nextSummaries: SessionSummary[] | null = null;
      setSessions((current) => {
        nextSummaries = mergeSessionSummaryList(current, sessionSnapshotToSummary(next));
        return nextSummaries;
      });
      if (nextSummaries) persistSessionSummaries(nextSummaries);
    };

    const syncActiveSummary = (patch: { title?: string; status?: ChatSession['status']; updated_at?: string; last_error?: string | null; pinned_at?: string | null; archived_at?: string | null; message_count?: number }) => {
      if (activeIdRef.current !== sessionId) return;
      setActive((current) => {
        if (!current || current.id !== sessionId) return current;
        const next: ChatSession = {
          ...current,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.updated_at !== undefined ? { updated_at: patch.updated_at } : {}),
          ...(patch.last_error !== undefined ? { last_error: patch.last_error || undefined } : {}),
          ...(patch.pinned_at !== undefined ? { pinned_at: patch.pinned_at } : {}),
          ...(patch.archived_at !== undefined ? { archived_at: patch.archived_at } : {}),
        };
        if (
          current.title === next.title
          && current.status === next.status
          && current.updated_at === next.updated_at
          && current.last_error === next.last_error
          && current.pinned_at === next.pinned_at
          && current.archived_at === next.archived_at
        ) {
          return current;
        }
        sessionCacheRef.current.set(next);
        persistActiveSession(next);
        if (!editingTitleRef.current && patch.title !== undefined) setTitleDraft(next.title);
        return next;
      });
      const summaryPatch = { id: sessionId, ...patch } as SessionSummaryLikePatch;
      setSessions((current) => mergeSessionSummaryList(current, summaryPatch));
    };

    source.addEventListener('open', () => {
      if (closed) return;
      setSessionStreamHealth('healthy');
    });

    source.addEventListener('session', (event) => {
      if (closed) return;
      perfMark('background:event-session', { session_id: sessionId });
      const next = JSON.parse((event as MessageEvent).data) as ChatSession;
      if (activeIdRef.current !== next.id) return;
      setSessionStreamHealth('healthy');
      let mergedSnapshot: ChatSession | null = null;
      setActive((current) => {
        mergedSnapshot = mergeSessionSnapshot(current, next);
        return mergedSnapshot;
      });
      if (mergedSnapshot) syncActiveSession(mergedSnapshot);
    });

    source.addEventListener('session-summary', (event) => {
      if (closed) return;
      perfMark('background:event-session-summary', { session_id: sessionId });
      const payload = JSON.parse((event as MessageEvent).data) as { session_id?: string; patch?: { title?: string; status?: ChatSession['status']; updated_at?: string; last_error?: string | null; pinned_at?: string | null; archived_at?: string | null; message_count?: number } };
      if (payload.session_id && payload.session_id !== sessionId) return;
      setSessionStreamHealth('healthy');
      if (!payload.patch) return;
      syncActiveSummary(payload.patch);
    });

    source.addEventListener('session-message', (event) => {
      if (closed) return;
      perfMark('background:event-session-message', { session_id: sessionId });
      const payload = JSON.parse((event as MessageEvent).data) as { session_id?: string; message?: SessionMessagePatch };
      if (payload.session_id && payload.session_id !== sessionId) return;
      const message = payload.message;
      if (message === undefined) return;
      setSessionStreamHealth('healthy');
      setActive((current) => {
        const next = mergeSessionMessage(current, sessionId, message);
        if (next === null) return next;
        sessionCacheRef.current.set(next);
        persistActiveSession(next);
        if (!editingTitleRef.current) setTitleDraft(next.title);
        setStreamingMessage(null);
        let nextSummaries: SessionSummary[] | null = null;
        setSessions((currentSessions) => {
          nextSummaries = mergeSessionSummaryList(currentSessions, sessionSnapshotToSummary(next));
          return nextSummaries;
        });
        if (nextSummaries) persistSessionSummaries(nextSummaries);
        return next;
      });
    });

    source.onerror = () => {
      if (closed) return;
      perfMark('background:eventsource-error', { session_id: sessionId });
      setSessionStreamHealth('error');
      source.close();
      if (reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (!closed && activeIdRef.current === sessionId && activeRunning) {
            setSessionStreamReconnectTick((tick) => tick + 1);
          }
        }, 1000);
      }
    };

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      source.close();
    };
  }, [active?.id, activeRunning, sessionStreamReconnectTick]);

  useEffect(() => {
    const reconcile = () => reconcileActiveSession().catch(() => undefined);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconcile();
    };
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    window.addEventListener('pageshow', reconcile);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
      window.removeEventListener('pageshow', reconcile);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setTitleDraft('');
      setEditingTitle(false);
      return;
    }
    setTitleDraft(active.title);
  }, [active?.id]);

  async function readImageFile(file: File): Promise<Attachment> {
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) throw new Error(`Unsupported image type: ${file.type || file.name}`);
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 4 MB`);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read image'));
      reader.readAsDataURL(file);
    });
    return { id: crypto.randomUUID(), type: 'image', name: file.name, mime_type: file.type, data_url: dataUrl, size_bytes: file.size };
  }

  async function addImageFiles(files: FileList | File[]) {
    try {
      const incoming = Array.from(files).slice(0, MAX_ATTACHMENTS - attachments.length);
      if (incoming.length === 0) return;
      const next = await Promise.all(incoming.map(readImageFile));
      setAttachments((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function pastedImageFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (files.length > 0) return files;

    return Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImageFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    addImageFiles(files);
  }

  async function respondToApproval(runId: string, choice: ApprovalChoice) {
    if (!active || approvalSubmitting) return;
    setApprovalSubmitting(`${runId}:${choice}`);
    try {
      const sessionId = active.id;
      const res = await fetch(`/api/sessions/${sessionId}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: runId, choice }),
      });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json().catch(() => ({}));
      const stale = Boolean(result?.stale || result?.code === 'approval_not_active');
      const approvalEvent: UiStreamEvent = stale
        ? {
            type: 'tool_output',
            tool_name: 'approval',
            summary: 'Approval expired. Hermes no longer has an active approval session for this run. Start a new turn if the command still needs to run.',
            status: 'failed',
            toolCallId: runId,
            raw_payload: { run_id: runId, choice, stale: true, code: 'approval_not_active' },
          }
        : { type: 'tool_output', tool_name: 'approval', summary: `Approval ${choice}`, status: 'complete', toolCallId: runId, raw_payload: { run_id: runId, choice } };
      setStreamingMessage((current) => {
        if (!current) return current;
        return { ...current, tool_events: upsertToolEvent(current.tool_events || [], approvalEvent) };
      });
      setActive((current) => {
        if (!current) return current;
        return {
          ...current,
          messages: current.messages.map((message) => ({
            ...message,
            tool_events: message.tool_events?.some((event) => approvalRunId(event) === runId)
              ? upsertToolEvent(message.tool_events || [], approvalEvent)
              : message.tool_events,
          })),
        };
      });
      await refreshSessions();
      if (activeIdRef.current === sessionId) await loadSession(sessionId, { preserveQueue: true, forceRefresh: true }).catch(() => undefined);
      setError(stale ? 'That approval had already expired, so I marked it stale. Start a new turn if it still needs to run.' : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovalSubmitting(null);
    }
  }

  async function queueComposer() {
    if (!active || isDraftSession(active)) return false;
    const content = input.trim();
    const outgoingAttachments = attachments;
    if (!content && outgoingAttachments.length === 0) return false;
    const activeQueueSize = queuedTurns.filter((turn) => turn.sessionId === active.id).length;
    if (activeQueueSize >= MAX_QUEUED_TURNS) {
      setError(`Queue is full (${MAX_QUEUED_TURNS} messages max).`);
      return false;
    }
    setInput('');
    setAttachments([]);
    setError(null);
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: active.id, content, attachments: outgoingAttachments }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const nextQueue = Array.isArray(data.queue) ? (data.queue as QueuedTurn[]) : [];
      setQueuedTurns(nextQueue);
      setQueuedAutoSend(nextQueue.length > 0);
      return true;
    } catch (err) {
      setInput(content);
      setAttachments(outgoingAttachments);
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function stopActiveTurn() {
    if (!active || isDraftSession(active)) return;
    try {
      const res = await fetch(`/api/sessions/${active.id}/stop`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setSending(false);
      setStreamingMessage((current) => (current ? { ...current, status: 'complete', content: current.content || 'Stopped.' } : current));
      setActive((current) => (current?.id === active.id ? { ...current, status: 'idle' } : current));
      await refreshSessions();
      await loadSession(active.id, { preserveQueue: true, forceRefresh: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function readJsonResponseBody(response: Response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { error: text };
    }
  }

  async function sendSteer(turn?: OutgoingTurn | QueuedTurn) {
    if (!active || !activeRunning || isDraftSession(active)) return;
    const content = (turn?.content ?? input).trim();
    const outgoingAttachments = turn?.attachments ?? attachments;
    const queuedTurnId = turn && 'id' in turn ? turn.id : null;
    if (!content || outgoingAttachments.length > 0 || steerSubmittingRef.current) return;
    steerSubmittingRef.current = true;
    if (queuedTurnId) {
      steeringQueuedTurnIdsRef.current = new Set([...steeringQueuedTurnIdsRef.current, queuedTurnId]);
      setSteeringQueuedTurnIds(new Set(steeringQueuedTurnIdsRef.current));
    }
    setInput('');
    if (!turn) setAttachments([]);
    setError(null);
    try {
      let res = await fetch(`/api/sessions/${active.id}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      for (let attempt = 1; !res.ok && attempt < 8; attempt += 1) {
        const body = await res.clone().text();
        if (res.status === 409) {
          try {
            const parsed = JSON.parse(body) as { code?: string; error?: string };
            if (parsed.code === 'stale_run') {
              await loadSession(active.id, { preserveQueue: true, forceRefresh: true, source: 'steer:stale-run' });
              await refreshQueue().catch(() => undefined);
              await refreshSessions();
              return true;
            }
          } catch {
            // Fall through to the existing retry / error handling path.
          }
        }
        if (res.status !== 409 || !body.toLowerCase().includes('still starting')) break;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        res = await fetch(`/api/sessions/${active.id}/steer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      }
      if (!res.ok) {
        const body = await readJsonResponseBody(res);
        if (body && body.code === 'stale_run') {
          await loadSession(active.id, { preserveQueue: true, forceRefresh: true, source: 'steer:stale-run' });
          await refreshQueue().catch(() => undefined);
          await refreshSessions();
          return true;
        }
        throw new Error(typeof body?.error === 'string' ? body.error : await res.text());
      }
      if (queuedTurnId) {
        await removeQueuedTurn(queuedTurnId);
      }
      await loadSession(active.id, { preserveQueue: true, forceRefresh: true });
      await refreshQueue().catch(() => undefined);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (!turn) setInput(content);
    } finally {
      steerSubmittingRef.current = false;
      if (queuedTurnId) {
        const nextIds = new Set(steeringQueuedTurnIdsRef.current);
        nextIds.delete(queuedTurnId);
        steeringQueuedTurnIdsRef.current = nextIds;
        setSteeringQueuedTurnIds(new Set(nextIds));
      }
    }
  }

  async function sendMessage(turn?: OutgoingTurn) {
    if (!turn && activeRunning) {
      return queueComposer();
    }
    const rawContent = (turn?.content ?? input).trim();
    perfMark('send:start', { queued: Boolean(turn), active_running: activeRunning });
    const projectTarget = !turn ? projectForMentionCommand(rawContent) : null;
    const content = projectTarget ? projectTarget.content : rawContent;
    const outgoingAttachments = turn?.attachments ?? attachments;
    if ((!content && outgoingAttachments.length === 0) || sending) return false;

    const targetSessionId = turn?.sessionId;
    let session: ChatSession;
    if (targetSessionId && active?.id !== targetSessionId) {
      const res = await fetch(`/api/sessions/${targetSessionId}`);
      if (!res.ok) throw new Error(await res.text());
      session = (await res.json()) as ChatSession;
    } else if (active && !projectTarget) {
      session = active;
    } else {
      session = createDraftSession(projectTarget?.project.id || activeProjectIdRef.current || null);
      activeIdRef.current = session.id;
      activeProjectIdRef.current = session.project_id || null;
      setActive(session);
      setTitleDraft(session.title);
    }

    const targetIsActive = activeIdRef.current === session.id;
    if (!turn) {
      setInput('');
      setAttachments([]);
      perfMark('send:composer-cleared', { session_id: session.id });
    }
    setError(null);
    setSending(true);
    if (targetIsActive) shouldStickToBottomRef.current = true;

    const clientTurnId = crypto.randomUUID();
    const userMessage: Message = { id: `local-user-${Date.now()}`, role: 'user', content, status: 'complete', created_at: new Date().toISOString(), attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined, metadata: { client_turn_id: clientTurnId } };
    const assistantMessage: Message = { id: `local-assistant-${Date.now()}`, role: 'assistant', content: '', status: 'streaming', created_at: new Date().toISOString(), tool_events: [], metadata: { continuation_strategy: session.continuation_strategy, client_turn_id: clientTurnId } };
    if (targetIsActive) {
      optimisticTurnRef.current = { sessionId: session.id, clientTurnId, userMessage, assistantMessage };
      activeIdRef.current = session.id;
      setActive({ ...session, messages: [...session.messages, userMessage] });
      setStreamingMessage(assistantMessage);
      perfMark('send:placeholder-visible', { session_id: session.id });
    }

    try {
      if (isDraftSession(session)) {
        const createRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: session.project_id || null }),
        });
        if (!createRes.ok) throw new Error(await createRes.text());
        const persisted = (await createRes.json()) as ChatSession;
        activeIdRef.current = persisted.id;
        optimisticTurnRef.current = { sessionId: persisted.id, clientTurnId, userMessage, assistantMessage };
        rememberSession(persisted.id);
        session = { ...persisted, messages: [] };
        setActive({ ...session, messages: [userMessage] });
      }
      perfMark('send:post-start', { session_id: session.id });
      const res = await fetch(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, attachments: outgoingAttachments, client_turn_id: clientTurnId }),
      });
      if (!res.ok) throw new Error(await res.text());
      perfMark('send:accepted', { session_id: session.id });
      const data = (await res.json()) as { user_message?: Message; assistant_message?: Message };
      const nextSessions = await refreshSessions('send:accepted');
      const refreshedSummary = nextSessions.find((item) => item.id === session.id);
      const nextSessionTitle = refreshedSummary?.title || session.title;
      if (activeIdRef.current === session.id && data.user_message && data.assistant_message) {
        optimisticTurnRef.current = { sessionId: session.id, clientTurnId, userMessage: data.user_message, assistantMessage: data.assistant_message };
        const nextSession = { ...session, title: nextSessionTitle, status: 'running' as const, messages: [...session.messages, data.user_message] };
        setActive(nextSession);
        persistActiveSession(nextSession);
        setTitleDraft(nextSession.title);
        setStreamingMessage(data.assistant_message);
        perfMark('send:persisted-placeholder-visible', { session_id: session.id });
      }
      return true;
    } catch (err) {
      if (optimisticTurnRef.current?.clientTurnId === clientTurnId) optimisticTurnRef.current = null;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (activeIdRef.current === session.id) {
        setStreamingMessage((current) => (current ? { ...current, status: 'failed', content: current.content || message } : null));
      }
      return false;
    } finally {
      setSending(false);
    }
  }

  async function sendQuickReply(content: string) {
    const reply = content.trim();
    if (!reply || (!activeRunning && sending)) return;
    if (activeRunning && active && !isDraftSession(active)) {
      await sendSteer({ content: reply, attachments: [] });
      return;
    }
    await sendMessage({ content: reply, attachments: [] });
  }

  function sessionIsRunning(sessionId: string) {
    if (active?.id === sessionId && activeRunning) return true;
    return sessions.some((session) => session.id === sessionId && session.status === 'running');
  }

  async function removeQueuedTurn(id: string) {
    const res = await fetch(`/api/queue?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const nextQueue = Array.isArray(data.queue) ? (data.queue as QueuedTurn[]) : [];
    setQueuedTurns(nextQueue);
    setQueuedAutoSend(nextQueue.length > 0);
  }

  async function reorderQueuedTurn(draggedId: string, targetId: string) {
    if (!active || draggedId === targetId) return;
    const sessionTurns = queuedTurns.filter((turn) => turn.sessionId === active.id);
    const fromIndex = sessionTurns.findIndex((turn) => turn.id === draggedId);
    const toIndex = sessionTurns.findIndex((turn) => turn.id === targetId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const reorderedSessionTurns = [...sessionTurns];
    const [draggedTurn] = reorderedSessionTurns.splice(fromIndex, 1);
    // Reusing the original target index places downward drags after the target and upward drags before it.
    reorderedSessionTurns.splice(toIndex, 0, draggedTurn);
    const reorderedIds = reorderedSessionTurns.map((turn) => turn.id);
    const reorderedIdSet = new Set(reorderedIds);
    const optimisticQueue = queuedTurns.map((turn) => {
      if (turn.sessionId !== active.id) return turn;
      const nextIndex = reorderedIds.indexOf(turn.id);
      return nextIndex >= 0 ? reorderedSessionTurns[nextIndex] : turn;
    });
    const mergedQueue = [
      ...optimisticQueue.filter((turn) => turn.sessionId !== active.id || !reorderedIdSet.has(turn.id)),
      ...reorderedSessionTurns,
    ];
    setQueuedTurns(mergedQueue);

    const res = await fetch('/api/queue', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: active.id, ordered_ids: reorderedIds }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const nextQueue = Array.isArray(data.queue) ? (data.queue as QueuedTurn[]) : [];
    setQueuedTurns(nextQueue);
    setQueuedAutoSend(nextQueue.length > 0);
  }

  async function submitQueuedTurn(queued: QueuedTurn) {
    if (queueSubmittingRef.current) return;
    if (sessionIsRunning(queued.sessionId)) {
      setQueuedAutoSend(true);
      return;
    }
    queueSubmittingRef.current = true;
    try {
      await removeQueuedTurn(queued.id);
      await sendMessage(queued);
      await refreshQueue().catch(() => undefined);
    } finally {
      queueSubmittingRef.current = false;
    }
  }

  useEffect(() => {
    if (queuedTurns.length === 0) return;
    const timer = window.setInterval(() => {
      refreshQueue().catch(() => undefined);
      refreshSessions().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [queuedTurns.length]);

  const orderedSessions = useMemo(() => [...pinnedTopLevelSessions, ...unpinnedSessions], [pinnedTopLevelSessions, unpinnedSessions]);
  const navigableSessionIds = useMemo(() => {
    const ids = new Set<string>();
    const ordered: string[] = [];
    const add = (session: SessionSummary) => {
      if (ids.has(session.id)) return;
      ids.add(session.id);
      ordered.push(session.id);
    };
    projects.forEach((project) => (projectSessionsById.get(project.id) || []).forEach(add));
    orderedSessions.forEach(add);
    return ordered;
  }, [orderedSessions, projectSessionsById, projects]);
  navigableSessionIdsRef.current = navigableSessionIds;
  const recentSessions = orderedSessions.slice(0, 8);
  const activeQueuedTurns = active ? queuedTurns.filter((turn) => turn.sessionId === active.id) : [];
  const activeQuickReplies = useMemo(() => quickReplies.map((reply) => reply.trim()).filter(Boolean).slice(0, MAX_QUICK_REPLIES), [quickReplies]);
  const composerHasContent = Boolean(input.trim() || attachments.length > 0);
  const showComposerAction = !activeRunning;
  const queuedPreview = (turn: QueuedTurn) => turn.content || (turn.attachments.length ? `${turn.attachments.length} image${turn.attachments.length === 1 ? '' : 's'}` : '');

  return (
    <main
      className="fixed inset-x-0 top-0 flex overflow-hidden bg-white text-neutral-950"
      style={{ height: 'var(--app-viewport-height)' }}
      onTouchStart={handleAppTouchStart}
      onTouchMove={handleAppTouchMove}
      onTouchEnd={handleAppTouchEnd}
    >
      {sidebarOpen && <button type="button" className="fixed inset-0 z-10 bg-black/10 backdrop-blur-[1px] md:hidden" aria-label="Close side panels" onClick={() => setSidebarOpen(false)} />}
      {contextMenu && (
        <div
          className="fixed z-50 hidden min-w-44 rounded-2xl border border-neutral-200 bg-white p-1.5 text-sm text-neutral-800 shadow-2xl md:block"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label={`Chat options for ${contextMenu.title}`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left font-medium hover:bg-neutral-100"
            role="menuitem"
            onClick={() => togglePinnedSession(contextMenu.sessionId).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          >
            <span>{pinnedSessionSet.has(contextMenu.sessionId) ? 'Unpin chat' : 'Pin chat'}</span>
            {pinnedSessionNumbers.has(contextMenu.sessionId) && <span className="ml-3 flex items-center gap-1 rounded-full bg-neutral-950 px-2 py-0.5 text-xs font-semibold text-white"><PinIcon className="h-3 w-3" />{pinnedSessionNumbers.get(contextMenu.sessionId)}</span>}
          </button>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left font-medium hover:bg-neutral-100"
            role="menuitem"
            onClick={() => archiveSession(contextMenu.sessionId).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          >
            <span>Archive chat</span>
            <ArchiveIcon className="ml-3 h-4 w-4 text-neutral-400" />
          </button>
        </div>
      )}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-20 flex w-[min(92vw,360px)] min-h-0 flex-col border-r border-neutral-200 bg-white/95 shadow-2xl backdrop-blur transition-[transform,width] duration-200 md:static md:translate-x-0 md:shadow-none',
          sidebarOpen ? 'translate-x-0 md:w-[360px]' : '-translate-x-full md:w-0 md:translate-x-0 md:border-r-0',
        )}
        onKeyDown={handleSidebarKeyDown}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 md:p-4">
          <div className={cx('min-w-0', !sidebarOpen && 'md:hidden')}>
            <p className="sr-only">{branding.workspaceShortName}</p>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{branding.workspaceName}</h1>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={refreshApp}
              className={cx('flex h-12 w-12 items-center justify-center rounded-full text-neutral-950 hover:bg-neutral-100', !sidebarOpen && 'md:hidden')}
              aria-label="Refresh app"
              title="Refresh app"
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              onClick={() => setSettingsSidebarOpen((value) => !value)}
              className={cx(
                'flex h-12 w-12 items-center justify-center rounded-full text-neutral-950 hover:bg-neutral-100',
                settingsSidebarOpen && 'bg-neutral-100',
                !sidebarOpen && 'md:hidden',
              )}
              aria-label={settingsSidebarOpen ? 'Close settings' : 'Open settings'}
              aria-expanded={settingsSidebarOpen}
              aria-pressed={settingsSidebarOpen}
              title="Settings"
            >
              <SettingsIcon />
            </button>
            <button
              type="button"
              onClick={() => setSidebarOpen((value) => !value)}
              className={cx('flex h-12 w-12 items-center justify-center rounded-full p-2 text-neutral-950 hover:bg-neutral-100', !sidebarOpen && 'md:hidden')}
              aria-label={sidebarOpen ? 'Collapse side panels' : 'Expand side panels'}
            >
              {sidebarOpen ? <CloseIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>

        <div className={cx('min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4', !sidebarOpen && 'hidden')}>
          {sidebarOpen && settingsSidebarOpen && (
            <SidebarSettingsPanel theme={theme} onThemeChange={setTheme} quickReplies={quickReplies} quickRepliesEnabled={quickRepliesEnabled} onQuickRepliesChange={setQuickReplies} onQuickRepliesEnabledChange={setQuickRepliesEnabled} onClose={() => setSettingsSidebarOpen(false)} />
          )}
          {sidebarOpen && !settingsSidebarOpen && (
            <>
              <section className="text-base">
                <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold uppercase tracking-wide text-neutral-400">
                  <span>Projects</span>
                  <button type="button" onClick={() => openProjectEditor()} className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100" aria-label="Create project"><PlusIcon className="h-5 w-5" /></button>
                </div>
                <nav className="space-y-2">
                  {projects.map((project) => {
                    const projectSessions = projectSessionsById.get(project.id) || [];
                    const projectCollapsed = collapsedProjectSet.has(project.id);
                    return (
                      <div key={project.id} className={cx('rounded-2xl', active?.project_id === project.id ? 'bg-sky-50' : '')}>
                        <div className={cx('group flex items-center gap-1 rounded-2xl px-2 py-1', active?.project_id === project.id ? 'bg-sky-50' : 'hover:bg-neutral-100')}>
                          <button
                            type="button"
                            onClick={() => toggleProjectCollapsed(project.id)}
                            disabled={projectSessions.length === 0}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-white hover:text-neutral-700 disabled:cursor-default disabled:opacity-30"
                            aria-label={`${projectCollapsed ? 'Expand' : 'Collapse'} chat history for ${project.name}`}
                            aria-expanded={!projectCollapsed}
                            title={`${projectCollapsed ? 'Expand' : 'Collapse'} chat history`}
                          >
                            <ChevronRightIcon className={cx('h-4 w-4 transition-transform', !projectCollapsed && 'rotate-90')} />
                          </button>
                          <button
                            type="button"
                            onClick={() => newSession(project.id).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                            className="min-w-0 flex-1 truncate px-1 py-1.5 text-left text-base font-medium text-neutral-800"
                            title={`New chat in ${project.name}`}
                          >
                            @{project.slug}
                          </button>
                          <button
                            type="button"
                            onClick={() => archiveSessionsInScope(project.id, `@${project.slug}`).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                            disabled={projectSessions.length === 0 || Boolean(archivingScope)}
                            className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 opacity-80 hover:bg-white hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
                            aria-label={`Archive chats in ${project.name}`}
                            title={`Archive chats in @${project.slug}`}
                          >
                            <ArchiveIcon className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => openProjectEditor(project)} className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 opacity-80 hover:bg-white hover:text-neutral-700 group-hover:opacity-100" aria-label={`Edit ${project.name}`}><MoreIcon className="h-5 w-5" /></button>
                        </div>
                        {projectSessions.length > 0 && !projectCollapsed && (
                          <div className="mt-1 space-y-1 pb-1 pl-10 pr-1">
                            {projectSessions.map((session) => (
                              <div
                                key={session.id}
                                onContextMenu={(event) => openSessionContextMenu(event, session)}
                                className={cx(
                                  'group flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-sm transition',
                                  active?.id === session.id ? 'bg-white text-sky-700 shadow-sm' : 'text-neutral-600 hover:bg-white/70 hover:text-neutral-950',
                                )}
                              >
                                <button
                                  type="button"
                                  onClick={() => openSession(session.id).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                                  onMouseEnter={() => prefetchSession(session.id).catch(() => undefined)}
                                  onFocus={() => prefetchSession(session.id).catch(() => undefined)}
                                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus:ring-2 focus:ring-neutral-300"
                                  data-session-nav="true"
                                  data-session-id={session.id}
                                  aria-current={active?.id === session.id ? 'page' : undefined}
                                >
                                  {renderSessionDot(session, 'h-1.5 w-1.5 shrink-0 rounded-full opacity-0 transition group-hover:opacity-50')}
                                  <span className="line-clamp-2 min-w-0 flex-1 font-normal leading-snug">{session.title}</span>
                                </button>
                                {pinnedSessionNumbers.has(session.id) && (
                                  <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-neutral-950 px-1 text-[10px] font-semibold leading-none text-white" aria-label={`Pinned shortcut ${pinnedSessionNumbers.get(session.id)}`} title={`Command ${pinnedSessionNumbers.get(session.id)}`}>
                                    {pinnedSessionNumbers.get(session.id)}
                                  </span>
                                )}
                                {renderSessionActions(session, 'compact')}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {projects.length === 0 && <div className="rounded-lg border border-dashed border-neutral-200 p-3 text-center text-xs text-neutral-400">No projects yet</div>}
                </nav>
              </section>

              <section className="text-base">
                <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold uppercase tracking-wide text-neutral-400">
                  <span>Chats</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => archiveSessionsInScope(null, 'Chats').catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                      disabled={topLevelSessions.length === 0 || Boolean(archivingScope)}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label="Archive chats"
                      title="Archive chats"
                    >
                      <ArchiveIcon className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => newSession(null).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100"
                      aria-label="Create chat"
                      title="New chat"
                    >
                      <PlusIcon className="h-5 w-5" />
                    </button>
                  </div>
                </div>
                <nav className="max-h-[64vh] space-y-1 overflow-y-auto pr-1">
                  {orderedSessions.map((session) => (
                    <div
                      key={session.id}
                      onContextMenu={(event) => openSessionContextMenu(event, session)}
                      className={cx(
                        'group flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-sm transition',
                        active?.id === session.id ? 'bg-sky-50 text-neutral-950' : 'text-neutral-700 hover:bg-neutral-100 hover:text-neutral-950',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => openSession(session.id).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                        onMouseEnter={() => prefetchSession(session.id).catch(() => undefined)}
                        onFocus={() => prefetchSession(session.id).catch(() => undefined)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus:ring-2 focus:ring-neutral-300"
                        data-session-nav="true"
                        data-session-id={session.id}
                        aria-current={active?.id === session.id ? 'page' : undefined}
                      >
                        {renderSessionDot(session, 'h-2 w-2 shrink-0 rounded-full opacity-0 transition group-hover:opacity-50')}
                        <span className="line-clamp-2 min-w-0 flex-1 font-normal leading-snug">{session.title}</span>
                      </button>
                      {pinnedSessionNumbers.has(session.id) && (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-neutral-950 px-1.5 text-[11px] font-semibold leading-none text-white" aria-label={`Pinned shortcut ${pinnedSessionNumbers.get(session.id)}`} title={`Command ${pinnedSessionNumbers.get(session.id)}`}>
                          {pinnedSessionNumbers.get(session.id)}
                        </span>
                      )}
                      {renderSessionActions(session)}
                    </div>
                  ))}
                  {topLevelSessions.length === 0 && <div className="rounded-lg border border-dashed border-neutral-200 p-3 text-center text-xs text-neutral-400">No chats yet</div>}
                </nav>
              </section>
            </>
          )}
        </div>
      </aside>

      {!sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="fixed left-4 top-4 z-30 hidden h-12 w-12 items-center justify-center rounded-2xl bg-white/90 text-neutral-950 shadow-sm ring-1 ring-neutral-200 backdrop-blur hover:bg-neutral-100 md:flex"
          aria-label="Expand side panels"
          title="Open sidebar"
        >
          <MenuIcon className="h-7 w-7" />
        </button>
      )}

      {editingProject && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Edit project">
          <div className="w-full max-w-lg rounded-[2rem] border border-neutral-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-950">{editingProject.id ? 'Edit project' : 'New project'}</h2>
              <button type="button" onClick={() => setEditingProject(null)} className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100" aria-label="Close project editor"><CloseIcon className="h-5 w-5" /></button>
            </div>
            <label className="block text-sm font-medium text-neutral-700">
              Name
              <input
                value={projectNameDraft}
                onChange={(event) => setProjectNameDraft(event.target.value)}
                className="mt-2 w-full rounded-2xl border border-neutral-200 px-3 py-2 text-neutral-950 outline-none focus:border-neutral-400"
                autoFocus
              />
            </label>
            <label className="mt-4 block text-sm font-medium text-neutral-700">
              System prompt
              <textarea
                value={projectPromptDraft}
                onChange={(event) => setProjectPromptDraft(event.target.value)}
                rows={7}
                className="mt-2 w-full resize-y rounded-2xl border border-neutral-200 px-3 py-2 text-neutral-950 outline-none focus:border-neutral-400"
                placeholder="Injected at the start of each new chat in this project."
              />
            </label>
            {editingProject.id && (
              <div className="mt-4 rounded-2xl border border-red-100 bg-red-50 p-3 text-sm text-red-700">
                <div className="flex items-start justify-between gap-3">
                  <p className="leading-snug">Delete this project permanently. Related chats are deleted too, and the @ mention will disappear.</p>
                  <button
                    type="button"
                    onClick={() => deleteEditingProject().catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                    className="shrink-0 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditingProject(null)} className="rounded-full px-4 py-2 text-sm font-medium text-neutral-500 hover:bg-neutral-100">Cancel</button>
              <button type="button" onClick={() => saveProject().catch((err) => setError(err instanceof Error ? err.message : String(err)))} className="rounded-full bg-neutral-950 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800">Save</button>
            </div>
          </div>
        </div>
      )}

      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 bg-white px-5 py-4 md:px-6">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <button
              onClick={() => setSidebarOpen((value) => !value)}
              className="-ml-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-neutral-950 hover:bg-neutral-100 md:hidden"
              aria-label={sidebarOpen ? 'Close side menu' : 'Open side menu'}
            >
              <MenuIcon className="h-7 w-7" />
            </button>
            <button
              type="button"
              onClick={() => newSession(null).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-950 hover:bg-neutral-200 md:hidden"
              aria-label="New chat"
              title="New chat"
            >
              <PlusIcon />
            </button>
            <div className="hidden min-w-0 flex-1 md:block">
              {active ? (
                <div className="flex min-w-0 items-center gap-2">
                  {editingTitle ? (
                    <>
                      <input
                        value={titleDraft}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            saveSessionTitle().catch((err) => setError(err instanceof Error ? err.message : String(err)));
                          }
                          if (event.key === 'Escape') {
                            setEditingTitle(false);
                            setTitleDraft(active.title);
                          }
                        }}
                        autoFocus
                        className="min-w-0 flex-1 rounded-2xl border border-neutral-200 bg-white px-3 py-2 text-xl font-semibold text-neutral-950 outline-none focus:border-neutral-400"
                      />
                      <button onClick={() => saveSessionTitle().catch((err) => setError(err instanceof Error ? err.message : String(err)))} className="rounded-full bg-neutral-950 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800">Save</button>
                      <button onClick={() => { setEditingTitle(false); setTitleDraft(active.title); }} className="rounded-full px-3 py-2 text-sm text-neutral-500 hover:bg-neutral-100">Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setEditingTitle(true)} className="flex min-w-0 rounded-xl py-1 text-left hover:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-neutral-200" title="Rename chat" aria-label="Rename chat">
                        <span className="truncate text-xl font-semibold tracking-tight">{active.title}</span>
                      </button>
                      {activeProject && <span className="shrink-0 rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">@{activeProject.slug}</span>}
                    </>
                  )}
                </div>
              ) : (
                <h2 className="text-xl font-semibold tracking-tight">{branding.workspaceName}</h2>
              )}
            </div>
          </div>
        </header>

        <div ref={transcriptRef} onScroll={handleTranscriptScroll} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-6 md:px-6">
          {transcriptMessages.length === 0 && streamingMessage === null && (
            <div className="mx-auto mt-24 max-w-5xl md:mt-32">
              <p className="text-xl font-normal leading-snug tracking-tight text-neutral-900">{branding.userGreeting}</p>
            </div>
          )}
          <TranscriptPanel
            messages={transcriptMessages}
            hiddenMessageCount={transcriptWindow.hiddenMessageCount}
            streamingMessage={streamingMessage}
            onRevealOlder={transcriptWindow.isCollapsed ? revealOlderTranscriptMessages : undefined}
            onApproval={respondToApproval}
            approvalSubmitting={approvalSubmitting}
            onFork={(messageId) => forkFromMessage(messageId).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          />
        </div>

        {showJumpToBottom && (
          <button
            type="button"
            onClick={() => scrollTranscriptToBottom()}
            className="absolute right-5 z-10 flex h-14 w-14 items-center justify-center rounded-full border border-neutral-200 bg-white/95 text-neutral-950 shadow-xl backdrop-blur transition hover:-translate-y-0.5 hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300 md:right-8"
            style={{ bottom: composerFooterHeight ? composerFooterHeight + 16 : 112 }}
            aria-label="Jump to latest message"
            title="Jump to latest message"
          >
            <ArrowDownIcon className="h-6 w-6" />
          </button>
        )}

        {error && <div className="shrink-0 px-5 py-2 text-sm text-red-600">{error}</div>}
        <div ref={composerFooterRef} className="composer-footer shrink-0 px-4 pb-2 pt-1 md:px-6 md:pb-6 md:pt-2">
          <div className="mx-auto max-w-5xl space-y-2 md:space-y-3">
            {pendingApproval && (
              <ApprovalBanner approval={pendingApproval} onApproval={respondToApproval} submittingKey={approvalSubmitting} />
            )}
            {activeQueuedTurns.length > 0 && (
              <div className="max-h-40 space-y-2 overflow-y-auto">
                {activeQueuedTurns.map((queuedTurn, index) => {
                  const isNext = index === 0;
                  const queueLabel = isNext && queuedAutoSend ? 'Sends next' : 'Queued';
                  return (
                    <div
                      key={queuedTurn.id}
                      draggable
                      onDragStart={(event: DragEvent<HTMLDivElement>) => {
                        setDraggingQueuedTurnId(queuedTurn.id);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', queuedTurn.id);
                      }}
                      onDragOver={(event: DragEvent<HTMLDivElement>) => {
                        if (!draggingQueuedTurnId || draggingQueuedTurnId === queuedTurn.id) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                      }}
                      onDrop={(event: DragEvent<HTMLDivElement>) => {
                        event.preventDefault();
                        const draggedId = event.dataTransfer.getData('text/plain') || draggingQueuedTurnId;
                        if (draggedId) reorderQueuedTurn(draggedId, queuedTurn.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                        setDraggingQueuedTurnId(null);
                      }}
                      onDragEnd={() => setDraggingQueuedTurnId(null)}
                      className={cx(
                        'composer-queue-item flex cursor-grab items-center gap-2 rounded-2xl px-3 py-2 text-sm shadow-sm active:cursor-grabbing',
                        draggingQueuedTurnId === queuedTurn.id && 'composer-queue-item-dragging opacity-50',
                      )}
                    >
                      <span className="composer-queue-grip flex h-8 w-5 shrink-0 items-center justify-center text-neutral-400" aria-hidden="true">
                        <GripIcon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-neutral-700">{queuedPreview(queuedTurn)}</div>
                      </div>
                      <span className="hidden shrink-0 text-xs font-medium text-neutral-400 sm:inline">{queueLabel}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setInput(queuedTurn.content);
                          setAttachments(queuedTurn.attachments);
                          removeQueuedTurn(queuedTurn.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                          focusComposerSoon();
                        }}
                        className="composer-queue-action rounded-full px-3 py-1.5 text-xs font-medium"
                      >
                        Edit
                      </button>
                      {(activeRunning || isNext) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (activeRunning) {
                              sendSteer(queuedTurn).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                            } else {
                              submitQueuedTurn(queuedTurn).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                            }
                          }}
                          disabled={activeRunning ? queuedTurn.attachments.length > 0 || steeringQueuedTurnIds.has(queuedTurn.id) : sending}
                          className="composer-queue-action composer-queue-action-primary rounded-full px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                          title={activeRunning && queuedTurn.attachments.length > 0 ? 'Image follow-ups will send after the current turn finishes.' : undefined}
                        >
                          {activeRunning ? 'Steer' : 'Send now'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          removeQueuedTurn(queuedTurn.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                        }}
                        className="composer-queue-action flex h-8 w-8 items-center justify-center rounded-full"
                        aria-label="Remove queued follow-up"
                      >
                        <CloseIcon className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="group relative overflow-hidden rounded-xl border border-neutral-200 bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={attachment.url ?? attachment.data_url ?? ''} alt={attachment.name} className="h-20 w-24 object-cover" />
                    <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-slate-950/80 text-white opacity-90 hover:bg-red-500" aria-label={`Remove ${attachment.name}`}><CloseIcon className="h-4 w-4" /></button>
                    <div className="max-w-24 truncate px-2 py-1 text-xs text-slate-400">{attachment.name}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex min-h-6 items-center gap-2 px-2 text-xs text-neutral-500">
              {activeProject && <span className="rounded-full bg-sky-50 px-2.5 py-1 font-semibold text-sky-700">Project: @{activeProject.slug}</span>}
              {mentionProjectSuggestions.length > 0 && (
                <span className="rounded-full bg-neutral-100 px-2.5 py-1">Tab selects @{mentionProjectSuggestions[0].slug}</span>
              )}
            </div>
            {quickRepliesEnabled && activeQuickReplies.length > 0 && (
              <div className="quick-reply-row flex gap-2 overflow-x-auto px-1 pb-0.5 [-webkit-overflow-scrolling:touch]" aria-label="Quick replies">
                {activeQuickReplies.map((reply, index) => (
                  <button
                    key={`${index}:${reply}`}
                    type="button"
                    onClick={() => sendQuickReply(reply).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                    disabled={!activeRunning && sending}
                    className="quick-reply-button inline-flex max-w-[12rem] shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                    title={`Send: ${reply}`}
                  >
                    <span className="quick-reply-number flex h-5 min-w-5 items-center justify-center rounded-full text-[11px] font-bold leading-none">{index + 1}</span>
                    <span className="truncate">{reply}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="composer-input-row flex items-end gap-2 rounded-[2rem] px-3 py-3 shadow-sm">
              <label className={cx('composer-icon-button inline-flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-full text-neutral-950', attachments.length >= MAX_ATTACHMENTS && 'cursor-not-allowed opacity-50')} aria-label="Attach image">
                <PlusIcon />
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    disabled={sending || attachments.length >= MAX_ATTACHMENTS}
                    onChange={(event) => {
                      if (event.target.files) addImageFiles(event.target.files);
                      event.currentTarget.value = '';
                    }}
                    className="hidden"
                  />
              </label>
              <textarea
                ref={composerRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={(event) => {
                  if (event.key === 'Tab') {
                    const quickReplyShortcut = quickRepliesEnabled ? input.match(/^\s*([1-3])\s*$/) : null;
                    if (quickReplyShortcut) {
                      const reply = activeQuickReplies[Number(quickReplyShortcut[1]) - 1];
                      if (reply) {
                        event.preventDefault();
                        setInput(reply);
                        focusComposerSoon();
                        return;
                      }
                    }
                    if (mentionProjectSuggestions.length > 0) {
                      event.preventDefault();
                      setInput(`@${mentionProjectSuggestions[0].slug} `);
                      focusComposerSoon();
                      return;
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage().catch((err) => setError(err instanceof Error ? err.message : String(err)));
                  }
                }}
                placeholder={`Ask ${branding.agentDisplayName}`}
                rows={1}
                className="composer-textarea min-h-12 flex-1 resize-none bg-transparent px-1 py-2.5 text-[17px] leading-7 text-neutral-950 outline-none placeholder:text-neutral-400"
              />
              {showComposerAction && (
                <button
                  onClick={() => {
                    sendMessage().catch((err) => setError(err instanceof Error ? err.message : String(err)));
                  }}
                  disabled={sending || !composerHasContent}
                  className="composer-send-button flex h-12 w-12 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Send message"
                >
                  {sending ? <LoadingDotsIcon className="h-6 w-6" /> : <SendIcon className="h-6 w-6" />}
                </button>
              )}
              {activeRunning && (
                <button
                  type="button"
                  onClick={stopActiveTurn}
                  className="composer-stop-button flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
                  aria-label="Stop generating"
                >
                  <StopIcon className="h-6 w-6" />
                </button>
              )}
            </div>
            <div className="sr-only">Paste images into the box, or use Image. PNG, JPG, WebP, GIF. Up to {MAX_ATTACHMENTS} files, 4 MB each.</div>
          </div>
        </div>
      </section>
    </main>
  );
}
