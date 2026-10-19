import { LOCAL_KEYS, LOCAL_PREFIXES } from "../storage-keys";
import { EMPTY_COMPOSER, storedComposer, type ComposerState } from "./composer";
import { storedSelections } from "./editor-selection";
import type { Attachment } from "./types";

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
const COMPOSER_PREFIX = LOCAL_PREFIXES.agentComposer;
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
 * The workspace's last-opened conversation id, or null if none. With an agent
 * serving conversations it is a pointer to an agent-minted id, resolved against
 * the agent on open; with an older agent it is the client-minted UUID the agent
 * keys its history by, which "New conversation" replaces. Never the workspace
 * path.
 */
export function loadConversationId(workspaceKey: string): string | null {
  const raw = readJson<{ id?: string }>(CONV_PREFIX + workspaceKey, {});
  return typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
}

export function saveConversationId(workspaceKey: string, id: string): void {
  writeJson(CONV_PREFIX + workspaceKey, { id });
}

export function clearConversationId(workspaceKey: string): void {
  localStorage.removeItem(CONV_PREFIX + workspaceKey);
}

function storedAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: Partial<Attachment> | null) =>
    entry &&
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.mediaType === "string" &&
    typeof entry.size === "number"
      ? [{ id: entry.id, name: entry.name, mediaType: entry.mediaType, size: entry.size }]
      : [],
  );
}

/** The composer as it was left under `key` (`composerKey`): its unsent text,
 *  its uploaded files and its queued message. Empty when nothing was stored, or
 *  what is stored is not a composer. */
export function loadComposer(key: string): ComposerState {
  const raw = readJson<{
    text?: unknown;
    attachments?: unknown;
    selections?: unknown;
    queued?: { text?: unknown; attachments?: unknown; selections?: unknown } | null;
  }>(COMPOSER_PREFIX + key, {});
  const text = typeof raw.text === "string" ? raw.text : "";
  const attachments = storedAttachments(raw.attachments).map((a) => ({ ...a, key: a.id, state: "uploaded" as const }));
  const selections = storedSelections(raw.selections);
  const queuedFiles = storedAttachments(raw.queued?.attachments);
  const queuedText = typeof raw.queued?.text === "string" ? raw.queued.text : "";
  const queued =
    queuedText || queuedFiles.length > 0
      ? { text: queuedText, attachments: queuedFiles, selections: storedSelections(raw.queued?.selections) }
      : null;
  return text || attachments.length > 0 || selections.length > 0 || queued
    ? { text, attachments, selections, queued }
    : EMPTY_COMPOSER;
}

/** Descriptors only, never bytes — and a composer with nothing to keep stores
 *  nothing: a key per conversation ever opened would only spend quota. */
export function saveComposer(key: string, composer: ComposerState): void {
  const stored = storedComposer(composer);
  const empty =
    stored.text === "" && stored.attachments.length === 0 && stored.selections.length === 0 && stored.queued === null;
  if (empty) clearComposer(key);
  else writeJson(COMPOSER_PREFIX + key, stored);
}

export function clearComposer(key: string): void {
  localStorage.removeItem(COMPOSER_PREFIX + key);
}
