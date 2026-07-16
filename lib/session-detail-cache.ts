import type { ChatSession } from './types';

export class SessionDetailCache {
  private readonly entries = new Map<string, ChatSession>();

  constructor(private readonly maxSize = 12) {}

  get size() {
    return this.entries.size;
  }

  has(sessionId: string) {
    return this.entries.has(sessionId);
  }

  get(sessionId: string) {
    const session = this.entries.get(sessionId);
    if (!session) return undefined;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, session);
    return session;
  }

  set(session: ChatSession) {
    if (this.entries.has(session.id)) this.entries.delete(session.id);
    this.entries.set(session.id, session);
    this.evictToLimit();
  }

  delete(sessionId: string) {
    return this.entries.delete(sessionId);
  }

  clear() {
    this.entries.clear();
  }

  keys() {
    return this.entries.keys();
  }

  ids() {
    return Array.from(this.entries.keys());
  }

  prune(visibleSessionIds: Set<string>) {
    for (const sessionId of this.entries.keys()) {
      if (!visibleSessionIds.has(sessionId)) this.entries.delete(sessionId);
    }
    this.evictToLimit();
  }

  private evictToLimit() {
    while (this.entries.size > this.maxSize) {
      const oldestSessionId = this.entries.keys().next().value;
      if (oldestSessionId === undefined) return;
      this.entries.delete(oldestSessionId);
    }
  }
}
