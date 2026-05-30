import * as vscode from 'vscode';

interface ChatHistoryEntry {
  sessionId: string;
  agentName: string;
  messages: unknown[];
  savedAt: number;
}

const STORAGE_KEY = 'fastopc.chatHistory.v1';
const MAX_SESSIONS = 50;

/**
 * Persists per-session chat message history to workspaceState so conversations
 * are recoverable across VS Code restarts even when the agent does not support
 * session/load or session/resume.
 */
export class ChatHistoryStore {
  private entries: ChatHistoryEntry[];

  constructor(private readonly state: vscode.Memento) {
    this.entries = state.get<ChatHistoryEntry[]>(STORAGE_KEY, []);
  }

  save(sessionId: string, agentName: string, messages: unknown[]): void {
    const idx = this.entries.findIndex(e => e.sessionId === sessionId);
    const entry: ChatHistoryEntry = { sessionId, agentName, messages, savedAt: Date.now() };
    if (idx >= 0) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }
    // Keep only the most-recently-updated sessions
    if (this.entries.length > MAX_SESSIONS) {
      this.entries.sort((a, b) => b.savedAt - a.savedAt);
      this.entries = this.entries.slice(0, MAX_SESSIONS);
    }
    void this.state.update(STORAGE_KEY, this.entries);
  }

  load(sessionId: string): unknown[] {
    return this.entries.find(e => e.sessionId === sessionId)?.messages ?? [];
  }

  delete(sessionId: string): void {
    this.entries = this.entries.filter(e => e.sessionId !== sessionId);
    void this.state.update(STORAGE_KEY, this.entries);
  }
}
