import type { AgentHistoryRow, ChatMessage } from "./types";

const CHAT_PREFIX = "telo-editor:agent-chat:";
const CONV_PREFIX = "telo-editor:agent-conv:";
const SETTINGS_KEY = "telo-editor:agent-settings-v1";

export interface AgentSettings {
  /** Dev override — a manually-run agent URL. When empty (the default) the
   *  editor launches a per-session agent instance on the active runner. */
  overrideUrl: string;
  /** Chat side-panel open state. */
  panelOpen: boolean;
}

/** The client-side display transcript + resume pointers, persisted per conversation. */
export interface PersistedChat {
  messages: ChatMessage[];
  /** The in-flight turn to re-attach to on reload, if any. */
  activeTurnId: string | null;
  /** Last SSE id seen for the active turn (resume cursor). */
  lastEventId: number;
  /** The agent session `activeTurnId` runs on. Re-attach is only valid against
   *  the same session — a different (re-launched) container has no journal for
   *  the turn and its event stream would tail forever. */
  agentSession?: string | null;
  /** The agent-persisted history rows (the model's view), snapshotted after
   *  each turn. Seeded into a fresh per-session instance before its first turn
   *  so the model sees the same conversation the panel shows. */
  history?: AgentHistoryRow[];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — best effort */
  }
}

export function loadAgentSettings(): AgentSettings {
  const data = readJson<Partial<AgentSettings>>(SETTINGS_KEY, {});
  return {
    overrideUrl: typeof data.overrideUrl === "string" ? data.overrideUrl : "",
    panelOpen: data.panelOpen === true,
  };
}

export function saveAgentSettings(settings: AgentSettings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function loadChat(conversationId: string): PersistedChat {
  const data = readJson<Partial<PersistedChat>>(CHAT_PREFIX + conversationId, {});
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    activeTurnId: typeof data.activeTurnId === "string" ? data.activeTurnId : null,
    lastEventId: typeof data.lastEventId === "number" ? data.lastEventId : 0,
    agentSession: typeof data.agentSession === "string" ? data.agentSession : null,
    history: Array.isArray(data.history) ? data.history : [],
  };
}

export function saveChat(conversationId: string, chat: PersistedChat): void {
  writeJson(CHAT_PREFIX + conversationId, chat);
}

export function clearChat(conversationId: string): void {
  try {
    localStorage.removeItem(CHAT_PREFIX + conversationId);
  } catch {
    /* private mode — best effort */
  }
}

/**
 * The current conversation id (a UUID) for a workspace, or null if none exists
 * yet. The agent keys its SQLite history by this id, so it must be a plain UUID
 * — never the workspace path. "Start over" mints a fresh one; a reload restores
 * it so the client transcript and the agent's server-side history stay aligned.
 */
export function loadConversationId(workspaceKey: string): string | null {
  const raw = readJson<{ id?: string }>(CONV_PREFIX + workspaceKey, {});
  return typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
}

export function saveConversationId(workspaceKey: string, id: string): void {
  writeJson(CONV_PREFIX + workspaceKey, { id });
}
