import type { Message } from './types';

export const DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD = 120;
export const DEFAULT_TRANSCRIPT_WINDOW_SIZE = 60;

export type TranscriptWindowOptions = {
  collapsed?: boolean;
  collapseThreshold?: number;
  windowSize?: number;
};

export type TranscriptWindow<T> = {
  visibleMessages: T[];
  hiddenMessageCount: number;
  isCollapsed: boolean;
};

export function getTranscriptWindow<T>(messages: readonly T[], options: TranscriptWindowOptions = {}): TranscriptWindow<T> {
  const collapseThreshold = options.collapseThreshold ?? DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD;
  const windowSize = options.windowSize ?? DEFAULT_TRANSCRIPT_WINDOW_SIZE;
  const shouldCollapse = options.collapsed ?? messages.length > collapseThreshold;

  if (!shouldCollapse || messages.length <= windowSize) {
    return {
      visibleMessages: Array.from(messages),
      hiddenMessageCount: 0,
      isCollapsed: false,
    };
  }

  const visibleMessages = Array.from(messages.slice(-windowSize));
  return {
    visibleMessages,
    hiddenMessageCount: Math.max(0, messages.length - visibleMessages.length),
    isCollapsed: true,
  };
}

export function transcriptMessageCount(messages: readonly Message[], streamingMessage?: Message | null) {
  return messages.length + (streamingMessage ? 1 : 0);
}
