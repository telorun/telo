import { LOCAL_KEYS, LOCAL_PREFIXES } from "../storage-keys";
import type { AgentHistoryRow, ChatMessage } from "./types";

/** The panel's width before anyone drags it (Tailwind's `w-96`, which it was
 *  fixed at) and the narrowest it can be dragged — below this the composer and
 *  the tool cards stop being readable. A stored width is clamped up to the
 *  minimum but never down to a maximum: what a wide panel leaves the editor
 *  depends on the window, so the ceiling is applied while dragging, where the
 *  window is known. */
export const AGENT_PANEL_DEFAULT_WIDTH = 384;
export const AGENT_PANEL_MIN_WIDTH = 280;

const CHAT_PREFIX = LOCAL_PREFIXES.agentChat;
const CONV_PREFIX = LOCAL_PREFIXES.agentConv;
const SETTINGS_KEY = LOCAL_KEYS.agentSettings;

export interface AgentSettings {
  /** Dev override — a manually-run agent URL. When empty (the default) the
   *  editor launches a per-session agent instance on the active runner. */
  overrideUrl: string;
  /** Chat side-panel open state. */
  panelOpen: boolean;
  /** Chat side-panel width in pixels, as the user last dragged it. */
  panelWidth: number;
  /** Render the agent's `telo-questions` blocks as clickable options. Off, the
   *  same block is shown as text and answered by typing — a render choice only,
   *  so it applies to messages already received and the agent is not told. */
  questionCards: boolean;
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
    panelWidth:
      typeof data.panelWidth === "number" && Number.isFinite(data.panelWidth)
        ? Math.max(AGENT_PANEL_MIN_WIDTH, data.panelWidth)
        : AGENT_PANEL_DEFAULT_WIDTH,
    // Default ON: a stored `false` is the only thing that turns it off, so a
    // settings blob written before this option existed keeps the cards.
    questionCards: data.questionCards !== false,
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
  writeJson(CHAT_PREFIX + conversationId, { ...chat, messages: chat.messages.map(withoutReasoning) });
}

/**
 * Reasoning is DISPLAY-ONLY and is dropped before persisting.
 *
 * It is never sent back to the agent (the encrypted reasoning that actually
 * matters rides `providerState` on the server side) and never read by resume,
 * so persisting it buys nothing — and at `medium` or `high` effort it is
 * several KB per turn against a ~5MB quota shared with the whole transcript.
 * Reaching that quota does not degrade gracefully: the write throws, the catch
 * in `writeJson` discards it, and `activeTurnId` / `lastEventId` silently stop
 * being recorded, so a reload loses the thread and cannot re-attach to an
 * in-flight turn. Keeping the volatile, valueless half out of the payload keeps
 * the cliff far away.
 */
function withoutReasoning(message: ChatMessage): ChatMessage {
  if (message.reasoning === undefined) return message;
  const { reasoning, ...rest } = message;
  return rest;
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
