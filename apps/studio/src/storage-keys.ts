/** Every browser-storage key studio writes, declared once.
 *
 *  Scheme: `telo-studio:<area>[:<sub>][:v<N>][:<variable>]` — one separator
 *  throughout, the version segment closing the fixed part of the key (a
 *  variable segment can contain anything, so a version after it is
 *  unreadable), and an area name that says what the data is rather than which
 *  module stores it.
 *
 *  Declared here rather than beside each reader because the legacy-key
 *  migration has to name every one of them: two copies of a key with nothing
 *  keeping them in agreement means bumping a version suffix in one place
 *  leaves the migration writing to a key no reader looks at — silent, and
 *  unrecoverable, since a one-shot migration gets one chance.
 *
 *  Split by STORE because the two are not interchangeable: run resume cursors
 *  are per-tab state in `sessionStorage`, everything else is `localStorage`.
 *  A key listed under the wrong one is a key that is never found.
 */

/** `localStorage`, whole keys. */
export const LOCAL_KEYS = {
  /** Cross-session UI focus: root dir, open tabs, active view. */
  uiState: "telo-studio:ui-state:v2",
  settings: "telo-studio:settings:v1",
  /** Accepted runner terms, keyed by runner id. */
  acceptedTerms: "telo-studio:accepted-terms",
  deployments: "telo-studio:deployments:v1",
  /** Cross-reload run index. Bump the suffix if the entry shape changes. */
  runIndex: "telo-studio:run:index:v1",
  colorMode: "telo-studio:color-mode",
  previewNoticeDismissed: "telo-studio:preview-notice-dismissed:v1",
  agentSettings: "telo-studio:agent:settings:v1",
} as const;

/** `localStorage`, key prefixes — the tail is a workspace path or an id. */
export const LOCAL_PREFIXES = {
  workspace: "telo-studio:workspace:",
  /** Undo/redo stack, one entry per workspace root. */
  history: "telo-studio:history:v1:",
  agentChat: "telo-studio:agent:chat:",
  agentConv: "telo-studio:agent:conv:",
} as const;

/** `sessionStorage`, key prefixes — the tail is a run session id. Resume
 *  cursors are deliberately per-tab: a cursor belongs to one live connection,
 *  and replaying another tab's would skip events this tab never saw. */
export const SESSION_PREFIXES = {
  runIoSeq: "telo-studio:run:io-seq:",
  runSseEventId: "telo-studio:run:sse-event-id:",
} as const;
