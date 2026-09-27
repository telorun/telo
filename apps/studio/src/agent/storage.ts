import { LOCAL_KEYS, LOCAL_PREFIXES } from "../storage-keys";

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

/**
 * Delete every transcript an earlier Studio kept in browser storage. The agent's
 * journal is the transcript now — read back from the records route — so a
 * stored copy is quota spent on something nothing reads, and would go stale the
 * moment another client continued the conversation.
 */
export function purgeStoredTranscripts(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CHAT_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* private mode — best effort */
  }
}

/**
 * The current conversation id (a UUID) for a workspace, or null if none exists
 * yet. The agent keys its conversation by this id, so it must be a plain UUID
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
