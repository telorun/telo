import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AgentClient,
  AgentRequestError,
  ERR_CONVERSATION_ARCHIVED,
  ERR_CONVERSATION_CHANGED,
  ERR_CONVERSATION_NOT_FOUND,
  ERR_CONVERSATION_REMOVED,
  ERR_TURN_IN_PROGRESS,
  ERR_UNAUTHENTICATED,
  TOKEN_REQUIRED_MESSAGE,
  type TurnRefused,
} from "./client";
import { AGENT_FEATURES, hasFeature } from "./agent-features";
import { exportJson, exportMarkdown } from "./transcript-export";
import { dropTurnsFrom } from "./turn-actions";
import { openAgentStream, type AgentStreamError, type AgentStreamHandle } from "./event-stream";
import { ownWorkspace } from "./agent-workspace";
import { launchAgentSession, type LaunchedAgent } from "./launch";
import { TermsRequiredError, type RunnerTerms } from "../run/types";
import { reconcile, seedDelta, pullFile } from "./sync";
import {
  applyRecord,
  applyTurnError,
  applyTurnStopped,
  describeTurnError,
  interruptedTurn,
  readConversation,
  toolOutputFields,
  transcriptFromTurns,
  userMessageId,
} from "./records";
import {
  loadAgentSettings,
  loadConversationId,
  purgeStoredTranscripts,
  saveAgentSettings,
  saveConversationId,
} from "./storage";
import type {
  AgentIdentityState,
  AgentStatus,
  AgentWorkspace,
  AssistantMessage,
  ChatMessage,
  CoResidentAgent,
  Conversation,
  ConversationPage,
  JournalRecord,
  ToolResult,
  WorkspaceBridge,
} from "./types";

/** How a Retry, Edit & resend or Delete from here ended: `changed` when the
 *  conversation moved on since the transcript was read — it has been re-read,
 *  and the action is to be asked again against it. */
export type TurnActionOutcome = "done" | "changed" | "failed";

/** A conversation exported for download. */
export interface ConversationDownload {
  filename: string;
  content: string;
  type: string;
}

interface AgentContextValue {
  // Panel + connection settings.
  panelOpen: boolean;
  togglePanel: () => void;
  /** Dev override URL; empty means launch a per-session agent on the runner. */
  overrideUrl: string;
  setOverrideUrl: (url: string) => void;
  /** The bearer token for the override URL's agent. Held in memory only: a
   *  credential is not written to browser storage. */
  overrideToken: string;
  setOverrideToken: (token: string) => void;
  /** What `GET /capabilities` said about the agent the panel talks to — asked
   *  once per agent instance; null until there is one to ask, or while asking. */
  identity: AgentIdentityState | null;
  /** Render the agent's question blocks as clickable options (default on). */
  questionCards: boolean;
  setQuestionCards: (enabled: boolean) => void;
  /** Panel width in pixels, as the user last dragged it. Committed at the END
   *  of a drag: per-pixel updates here would rebuild this context value and
   *  re-render every consumer of it on every pointer move. */
  panelWidth: number;
  setPanelWidth: (width: number) => void;

  // Conversation state.
  conversationId: string | null;
  messages: ChatMessage[];
  status: AgentStatus;
  /** Manual mutation is disabled while a turn is in flight. */
  locked: boolean;
  error: string | null;

  send: (message: string) => void;
  /** Abort the running turn: its stream stays open until the cancellation ends
   *  it, and the turn then reads as stopped. */
  stop: () => void;
  /** Pick an interrupted turn back up: resend a message that never started a
   *  turn, otherwise continue the turn on the agent — inside the same turn, and
   *  re-attached to its stream if it is in fact still running. */
  retry: () => void;
  /** True when there is something `retry()` would act on. */
  canRetry: boolean;
  /** Start a fresh conversation for this workspace. With an agent serving
   *  `conversations` this opens a draft the first send creates, and the current
   *  one stays in the list; with an older agent a new id is minted at once. */
  clearConversation: () => void;

  // Conversations — only with an agent whose capabilities list `conversations`.
  /** Which conversation surfaces the agent serves: truncation and branching
   *  count only alongside `conversations`. */
  features: { conversations: boolean; truncation: boolean; branching: boolean };
  /** The open conversation as the agent last reported it; null for a draft and
   *  with an agent that does not serve conversations. */
  conversation: Conversation | null;
  /** No conversation yet: the first send creates one. */
  draft: boolean;
  listConversations: (query: {
    archived: boolean;
    q?: string;
    limit?: number;
    cursor?: { before: string; beforeId: string } | null;
  }) => Promise<ConversationPage>;
  /** Open a conversation from the list; it becomes the workspace's last-opened one. */
  openConversation: (conversation: Conversation) => void;
  renameConversation: (id: string, title: string) => Promise<void>;
  setConversationArchived: (id: string, archived: boolean) => Promise<void>;
  /** Delete a conversation. `running` when its latest turn runs and
   *  `stopRunning` is false; with it, the turn is aborted, its stream waited
   *  out, and the conversation deleted. */
  deleteConversation: (id: string, stopRunning: boolean) => Promise<"deleted" | "running">;
  exportConversation: (id: string, format: "markdown" | "json") => Promise<ConversationDownload>;
  /** Delete from here: remove `turnId` and every later turn. */
  truncateFrom: (turnId: string) => Promise<TurnActionOutcome>;
  /** Retry / Edit & resend: remove `turnId` and every later turn, then send `text`. */
  resendFrom: (turnId: string, text: string) => Promise<TurnActionOutcome>;
  /** Branch: a new conversation holding every turn through `turnId`, opened. */
  branchFrom: (turnId: string) => Promise<void>;

  // Wiring from the editor shell.
  setConversation: (id: string | null) => void;
  registerWorkspace: (bridge: WorkspaceBridge | null) => void;
  /** The active runner's base URL, used to launch a per-session agent. */
  setRunner: (baseUrl: string | null) => void;
  /** The agent riding inside a live watch session, when there is one. Preferred
   *  over launching a session of the agent's own: it already shares the volume
   *  the running applications watch, so a file it writes reloads them. */
  setCoResidentAgent: (agent: CoResidentAgent | null) => void;
  /** The runner's terms version the user has accepted (null when the runner
   *  has no terms or they aren't accepted yet) — sent on the agent launch so
   *  a terms-enforcing runner doesn't 428 it. */
  setRunnerAcceptedTerms: (version: string | null) => void;
  /** Register the shell's terms gate. A terms-enforcing runner refuses the
   *  agent launch with its current agreement, which is the same gate a run is
   *  refused with — so it is handed to the shell that owns the dialog rather
   *  than reported as an error telling the user to go and run something else to
   *  find it. Accepting it and calling `retry()` resumes the turn. */
  registerTermsGate: (handler: ((terms: RunnerTerms) => void) | null) => void;
}

/** An agent the panel can talk to: where it answers, its bearer token when it
 *  has one, and the workspace surface that goes with it. */
interface ReachableAgent {
  url: string;
  token?: string;
  workspace: AgentWorkspace;
}

/** One agent instance: its URL and the token it is talked to with. */
function agentKey(agent: { url: string; token?: string }): string {
  return `${agent.url}\n${agent.token ?? ""}`;
}

/** Heuristic for "the per-session container is gone": a network-level fetch
 *  failure, or a gateway error from the proxy fronting a dead upstream. Used to
 *  decide when a cached launch should be dropped and re-created. */
function isUpstreamGone(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network failure
  const message = err instanceof Error ? err.message : String(err);
  return /\((502|503|504)\)/.test(message);
}

/** What the user reads for a refused turn start or continue, by the refusal's
 *  `code`. A turn already running for this conversation is an error, not
 *  something to attach to: this client's own retries are recognised by their
 *  `Idempotency-Key`, and a continue of a turn that is still running attaches
 *  to it before this is reached, so a running turn named here is another one. */
function refusalMessage(refusal: TurnRefused): string {
  const retryIn = refusal.retryAfter ? ` in ${refusal.retryAfter}s` : "";
  switch (refusal.code) {
    case "ERR_AT_CAPACITY":
      return `The agent is at capacity — try again${retryIn}.`;
    case "ERR_RATE_LIMITED":
      return `Too many turns started — try again${retryIn}.`;
    case "ERR_TURN_IN_PROGRESS":
      return "A turn is already running for this conversation.";
    case "ERR_TURN_NOT_CONTINUABLE":
      return refusal.reason === "finished"
        ? "This turn already finished — there is nothing to resume."
        : refusal.reason === "aborted"
          ? "This turn was stopped, so it cannot be resumed — send a new message instead."
          : "A later turn followed this one; only the last turn can be resumed.";
    case "ERR_TURN_NOT_FOUND":
    case "ERR_JOURNAL_KEY_REMOVED":
      return "The agent no longer has this turn — send your message again.";
    case ERR_UNAUTHENTICATED:
      return TOKEN_REQUIRED_MESSAGE;
    case ERR_CONVERSATION_NOT_FOUND:
      return goneNotice(404);
    case ERR_CONVERSATION_REMOVED:
      return goneNotice(410);
    case ERR_CONVERSATION_ARCHIVED:
      return `This conversation is archived — unarchive it to continue. (${refusal.code})`;
    default:
      return refusal.message;
  }
}

/** How a turn's stream ends when its running attempt was cancelled. */
const ERR_INVOKE_CANCELLED = "ERR_INVOKE_CANCELLED";

/** What the user reads when the open conversation is gone from the agent. */
const GONE_MESSAGE = {
  404: "The agent no longer has this conversation.",
  410: "This conversation was deleted.",
} as const;

/** Why the open conversation was left, by the status it answered. */
function goneNotice(gone: 404 | 410): string {
  return `${GONE_MESSAGE[gone]} (${gone === 410 ? ERR_CONVERSATION_REMOVED : ERR_CONVERSATION_NOT_FOUND})`;
}

/** A workspace whose conversation could not be resolved for a reason other than
 *  404/410, retried in the revision poll's slot; `notice` says why the one open
 *  before was left, when it was. */
interface Unresolved {
  workspaceKey: string;
  notice?: string;
}

/** How often an open, visible panel asks whether its conversation changed. */
export const CONVERSATION_POLL_MS = 5000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A 404 or 410 about the conversation itself, rather than about a turn of it. */
function goneStatus(err: unknown): 404 | 410 | null {
  if (!(err instanceof AgentRequestError)) return null;
  if (err.status === 410 && err.code === ERR_CONVERSATION_REMOVED) return 410;
  if (err.status === 404 && err.code === ERR_CONVERSATION_NOT_FOUND) return 404;
  return null;
}

/** Wait for a turn's event stream to end — its cancellation, its finish, or the
 *  stream given up. */
function waitForTurnEnd(baseUrl: string, token: string | undefined, turnId: string): Promise<void> {
  return new Promise((resolve) => {
    const handle = openAgentStream({
      baseUrl,
      token,
      turnId,
      fromId: 0,
      onRecord: () => undefined,
      onError: () => {
        handle.close();
        resolve();
      },
      onEnd: resolve,
    });
  });
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent() called outside <AgentProvider>");
  return ctx;
}

export function AgentProvider({ children }: { children: ReactNode }) {
  // The transcript is the agent's journal, read back from the records route —
  // any copy an earlier Studio kept in browser storage goes on first load.
  const initialSettings = useRef<ReturnType<typeof loadAgentSettings> | null>(null);
  if (initialSettings.current === null) {
    purgeStoredTranscripts();
    initialSettings.current = loadAgentSettings();
  }
  const [panelOpen, setPanelOpen] = useState(initialSettings.current.panelOpen);
  const [overrideUrl, setOverrideUrlState] = useState(initialSettings.current.overrideUrl);
  const [overrideToken, setOverrideTokenState] = useState("");
  const [identity, setIdentity] = useState<AgentIdentityState | null>(null);
  const [questionCards, setQuestionCards] = useState(initialSettings.current.questionCards);
  const [panelWidth, setPanelWidth] = useState(initialSettings.current.panelWidth);

  const [conversationId, setConversationId] = useState<string | null>(null);
  // The open conversation's agent-side state, and the agent (URL + token) it
  // was read from: a conversation is one agent's, never carried to another.
  const [conversation, setConversationState] = useState<Conversation | null>(null);
  const conversationRef = useRef<Conversation | null>(null);
  const conversationAgentRef = useRef<string | null>(null);
  const setConversationMeta = useCallback((next: Conversation | null) => {
    conversationRef.current = next;
    setConversationState(next);
  }, []);
  // Set while the workspace's conversation waits for the agent to say whether it
  // serves conversations — which decides between resolving the last-opened
  // pointer against the agent and minting an id as an older agent needs.
  const deferredResolveRef = useRef(false);
  // Set while the workspace's conversation could not be resolved: the pointed
  // one stays open unadopted (or a draft shows, with no pointer), and the
  // resolution is retried in the revision poll's slot. `resolveErrorRef` is the
  // error it showed, cleared on success only while it is still the one shown.
  const [unresolved, setUnresolvedState] = useState<Unresolved | null>(null);
  const unresolvedRef = useRef<Unresolved | null>(null);
  const markUnresolved = useCallback((next: Unresolved | null) => {
    unresolvedRef.current = next;
    setUnresolvedState(next);
  }, []);
  const resolveErrorRef = useRef<string | null>(null);
  // Bumped by every resolution and by a send adopting its conversation, so a
  // resolution still in flight notices it was superseded.
  const resolveGenRef = useRef(0);
  const resolvingRef = useRef(false);
  // The workspace's conversation was settled by something other than the
  // resolution — a send adopting one, a branch, the workspace closing.
  const supersedeResolution = useCallback(() => {
    resolveGenRef.current++;
    resolvingRef.current = false;
    markUnresolved(null);
    resolveErrorRef.current = null;
  }, [markUnresolved]);
  // A revision change seen while a turn of this client ran: the transcript is
  // re-read once the turn's stream ends, never under it.
  const staleRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [turnId, setTurnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A message whose send failed before the agent admitted it: there is no turn
  // to continue, so a retry sends it again.
  const [unsent, setUnsent] = useState<{ text: string; userId: string; assistantId: string } | null>(null);
  const unsentRef = useRef(unsent);
  unsentRef.current = unsent;

  const bridgeRef = useRef<WorkspaceBridge | null>(null);
  const streamRef = useRef<AgentStreamHandle | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  // Set while an accepted abort waits for the turn's cancellation to end its
  // stream: the ERR_INVOKE_CANCELLED frame then reads as Stopped, not as an error.
  const stoppingRef = useRef(false);
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;
  const turnIdRef = useRef<string | null>(null);
  turnIdRef.current = turnId;
  // Bumped by stop() (and each send) so an in-flight send pipeline notices it
  // was superseded and bails between awaits instead of resurrecting the turn.
  const sendGenRef = useRef(0);
  // The raw workspace key from the editor (its rootDir). The effective
  // conversationId is this key plus the workspace's current generation, which
  // "start over" bumps.
  const workspaceKeyRef = useRef<string | null>(null);
  // The effective agent base URL (a launched per-session instance, or the dev
  // override). Read through a ref so the callbacks below stay stable.
  const agentUrlRef = useRef<string>("");
  // The bearer token of that agent, resolved together with its URL: the
  // override's token, the runner-minted one of a co-resident or launched agent.
  const agentTokenRef = useRef<string | undefined>(undefined);
  const overrideRef = useRef(overrideUrl);
  overrideRef.current = overrideUrl;
  const overrideTokenRef = useRef(overrideToken);
  overrideTokenRef.current = overrideToken;
  const runnerBaseRef = useRef<string | null>(null);
  const runnerTermsRef = useRef<string | null>(null);
  const termsGateRef = useRef<((terms: RunnerTerms) => void) | null>(null);
  const launchedRef = useRef<LaunchedAgent | null>(null);
  // The agent inside a live watch session, pushed in by the editor shell as
  // sessions come and go. Read at the start of a send, never mid-turn.
  const coResidentRef = useRef<CoResidentAgent | null>(null);
  // Which surface the shared workspace is reached through for the agent
  // currently in use — the session's volume for a co-resident agent, the
  // agent's own directory otherwise. Resolved together with the base URL, so
  // the two can never disagree about which agent is being talked to.
  const workspaceRef = useRef<AgentWorkspace | null>(null);
  // Read by retry(), through a ref so the callback stays stable across every
  // streamed delta.
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const locked = status === "launching" || status === "seeding" || status === "streaming" || status === "stopping";
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const statusRef = useRef(status);
  statusRef.current = status;
  const identityRef = useRef<AgentIdentityState | null>(identity);
  const conversationsOn = hasFeature(identity, AGENT_FEATURES.conversations);

  const client = useCallback(() => new AgentClient(agentUrlRef.current, agentTokenRef.current), []);

  // Drop a launched per-session instance whose upstream looks gone (reaped
  // container, dead proxy route): the next send re-launches instead of failing
  // forever against a cached URL. Fires a best-effort DELETE so a container
  // that is in fact still alive doesn't leak on the runner.
  const invalidateLaunched = useCallback((reason: string) => {
    const launched = launchedRef.current;
    if (!launched) return;
    launchedRef.current = null;
    agentUrlRef.current = "";
    agentTokenRef.current = undefined;
    console.warn(`Dropping agent session '${launched.sessionId}': ${reason}`);
    void launched.stop();
    refreshIdentityRef.current();
  }, []);

  // The agent to talk to right now, without launching one, in the precedence
  // below — and the one a conversation's records are read from and its turn
  // continued on, since a launched per-session instance is new and holds none.
  const reachableAgent = useCallback((): ReachableAgent | null => {
    const override = overrideRef.current;
    if (override) {
      const token = overrideTokenRef.current || undefined;
      return { url: override, token, workspace: ownWorkspace(new AgentClient(override, token)) };
    }
    const coResident = coResidentRef.current;
    if (coResident) return { url: coResident.baseUrl, token: coResident.token, workspace: coResident.workspace };
    const launched = launchedRef.current;
    if (launched) {
      return {
        url: launched.agentUrl,
        token: launched.token,
        workspace: ownWorkspace(new AgentClient(launched.agentUrl, launched.token)),
      };
    }
    return null;
  }, []);

  const selectAgent = useCallback((agent: ReachableAgent) => {
    agentUrlRef.current = agent.url;
    agentTokenRef.current = agent.token;
    workspaceRef.current = agent.workspace;
  }, []);

  // Ask the agent the panel would talk to who it is — once per instance (URL
  // and token), since the answer does not change while it runs. A reply for an
  // agent no longer current is dropped.
  const identityKeyRef = useRef<string | null>(null);
  // The answer for the agent currently asked, for a send that must know it
  // before it can decide how the conversation is created.
  const identityAnswerRef = useRef<Promise<AgentIdentityState> | null>(null);
  const refreshIdentityRef = useRef<() => void>(() => undefined);
  // Assigned below, once the conversation resolver exists.
  const onIdentityRef = useRef<() => void>(() => undefined);
  refreshIdentityRef.current = () => {
    const agent = reachableAgent();
    const key = agent ? agentKey(agent) : null;
    if (key === identityKeyRef.current) return;
    identityKeyRef.current = key;
    identityRef.current = null;
    setIdentity(null);
    if (!agent) {
      identityAnswerRef.current = null;
      return;
    }
    const answer = new AgentClient(agent.url, agent.token)
      .capabilities()
      .catch((err: unknown): AgentIdentityState => ({ state: "failed", message: message(err) }));
    identityAnswerRef.current = answer;
    void answer.then((state) => {
      if (identityKeyRef.current !== key) return;
      identityRef.current = state;
      setIdentity(state);
      onIdentityRef.current();
    });
  };
  // What the selected agent serves, asked now if nobody has yet.
  const currentIdentity = useCallback(async (): Promise<AgentIdentityState | null> => {
    refreshIdentityRef.current();
    return identityAnswerRef.current ? identityAnswerRef.current : null;
  }, []);
  // The override is typed a character at a time: ask once it settles.
  useEffect(() => {
    const timer = setTimeout(() => refreshIdentityRef.current(), 400);
    return () => clearTimeout(timer);
  }, [overrideUrl, overrideToken]);

  // Ensure an agent instance is reachable, and say which workspace surface goes
  // with it. Precedence: the dev override, then a live watch session's
  // co-resident agent, then launching a session of the agent's own.
  //
  // The co-resident agent outranks a launched one even when a launched one is
  // already cached, and the cached one is torn down. It is not a preference:
  // only the co-resident agent writes the volume the running applications
  // watch, so only its edits reload the app the user is looking at. Switching
  // instances loses what the previous one journaled: the transcript and the
  // model's history live in the agent that ran the turns, and nothing is
  // ferried to another instance.
  //
  // Resolved at the start of a send, so an agent that appears mid-turn is
  // picked up on the next one rather than halfway through this one.
  const ensureAgent = useCallback(async () => {
    const reachable = reachableAgent();
    if (reachable) {
      if (!overrideRef.current && coResidentRef.current && launchedRef.current) {
        const stale = launchedRef.current;
        launchedRef.current = null;
        void stale.stop();
      }
      selectAgent(reachable);
      return;
    }
    if (!runnerBaseRef.current) {
      throw new Error("No runner selected — pick a runner in settings, or set a dev agent URL.");
    }
    setStatus("launching");
    const launched = await launchAgentSession(runnerBaseRef.current, runnerTermsRef.current);
    launchedRef.current = launched;
    selectAgent({
      url: launched.agentUrl,
      token: launched.token,
      workspace: ownWorkspace(new AgentClient(launched.agentUrl, launched.token)),
    });
    refreshIdentityRef.current();
  }, [reachableAgent, selectAgent]);

  // ── persistence ───────────────────────────────────────────────────────────
  useEffect(() => {
    saveAgentSettings({ overrideUrl, panelOpen, questionCards, panelWidth });
  }, [overrideUrl, panelOpen, panelWidth, questionCards]);

  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);
  const setOverrideUrl = useCallback((url: string) => setOverrideUrlState(url), []);
  const setOverrideToken = useCallback((token: string) => setOverrideTokenState(token), []);
  const registerWorkspace = useCallback((bridge: WorkspaceBridge | null) => {
    bridgeRef.current = bridge;
  }, []);
  const setRunner = useCallback((base: string | null) => {
    runnerBaseRef.current = base;
  }, []);
  // Assigned below, once the transcript loader exists: a co-resident agent that
  // appears after a conversation was opened is where that conversation's
  // records are.
  const onCoResidentRef = useRef<() => void>(() => undefined);
  const setCoResidentAgent = useCallback((agent: CoResidentAgent | null) => {
    const appeared = agent !== null && coResidentRef.current?.baseUrl !== agent.baseUrl;
    coResidentRef.current = agent;
    refreshIdentityRef.current();
    if (appeared) onCoResidentRef.current();
  }, []);
  const setRunnerAcceptedTerms = useCallback((version: string | null) => {
    runnerTermsRef.current = version;
  }, []);
  const registerTermsGate = useCallback((handler: ((terms: RunnerTerms) => void) | null) => {
    termsGateRef.current = handler;
  }, []);

  const updateAssistant = useCallback((id: string, fn: (m: AssistantMessage) => AssistantMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id && m.role === "assistant" ? fn(m) : m)));
  }, []);

  // ── journal record → transcript ─────────────────────────────────────────────
  // The same reducer the records route is folded with, so a live turn renders
  // exactly as it will after a reload.
  const applyStreamRecord = useCallback((turn: string, record: JournalRecord) => {
    setMessages((prev) => applyRecord(prev, turn, record));
    // The generated title names the conversation as soon as it is journaled —
    // unless it already has one, which the agent does not overwrite either.
    const title = (record.data as { type: string; title?: unknown }).title;
    if (record.data.type === "conversation-title" && typeof title === "string") {
      const current = conversationRef.current;
      if (current && current.title === null) setConversationMeta({ ...current, title });
    }
    // Eager reflection: pull the one file the agent just wrote.
    if (record.data.type !== "tool-result") return;
    const raw = (record.data as { toolResult?: ToolResult }).toolResult;
    const { path } = toolOutputFields(raw);
    const bridge = bridgeRef.current;
    const workspace = workspaceRef.current;
    if (raw && path && bridge && workspace && (raw.name === "write_file" || raw.name === "edit_file")) {
      void pullFile(workspace, bridge, path).catch((err) => {
        // Mid-turn reflection is redone by the end-of-turn reconcile — log so
        // the failure isn't invisible in the meantime.
        console.error(`Failed to pull '${path}' from the agent workspace`, err);
      });
    }
  }, [setConversationMeta]);

  // Assigned below, once the conversation poll exists: a turn's ending changed
  // the conversation, and whatever else changed it meanwhile is read now.
  const afterTurnRef = useRef<() => void>(() => undefined);

  const endTurn = useCallback(async () => {
    const bridge = bridgeRef.current;
    const workspace = workspaceRef.current;
    stoppingRef.current = false;
    turnIdRef.current = null;
    lockedRef.current = false;
    setStatus("idle");
    setTurnId(null);
    afterTurnRef.current();
    if (bridge && workspace) {
      try {
        await reconcile(workspace, bridge);
      } catch (err) {
        // The next turn re-seeds, but the user must know the editor may be
        // showing stale files right now.
        setError(
          `Failed to reflect the agent's workspace changes into the editor: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }, []);

  // A cancellation this client did not ask for — another client's Stop, or the
  // agent shutting down — is told apart by the turn's status as the records
  // route reports it, so the live view ends the turn exactly as a reload shows
  // it: Stopped when a user aborted it, the cancellation as its error otherwise.
  const settleUnrequestedCancel = useCallback(async (turn: string, cancel: AgentStreamError) => {
    const convId = conversationIdRef.current;
    const reply = messagesRef.current.find((m): m is AssistantMessage => m.id === turn && m.role === "assistant");
    const showCancelled = (note?: string) => {
      const ending = { code: cancel.code, message: cancel.message };
      setError(note === undefined ? describeTurnError(ending) : `${describeTurnError(ending)} ${note}`);
      setMessages((prev) => applyTurnError(prev, turn, ending));
    };
    if (!convId) {
      showCancelled();
      return;
    }
    try {
      const page = await client().records(convId, { fromTurn: turn, fromId: reply?.lastRecordId ?? 0 });
      if (conversationIdRef.current !== convId) return;
      if (page.turns.find((t) => t.turnId === turn)?.status === "aborted") {
        setMessages((prev) => applyTurnStopped(prev, turn));
        return;
      }
      showCancelled();
    } catch (err) {
      if (conversationIdRef.current !== convId) return;
      showCancelled(`Its status could not be read from the agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client]);

  const attachStream = useCallback(
    (activeTurnId: string, fromId: number) => {
      streamRef.current?.close();
      streamRef.current = openAgentStream({
        baseUrl: agentUrlRef.current,
        token: agentTokenRef.current,
        turnId: activeTurnId,
        fromId,
        onRecord: (record) => applyStreamRecord(activeTurnId, record),
        onError: (err: AgentStreamError) => {
          if (err.code === ERR_INVOKE_CANCELLED && stoppingRef.current) {
            // The abort this client asked for: an ending, not a failure.
            setMessages((prev) => applyTurnStopped(prev, activeTurnId));
            return;
          }
          if (err.code === ERR_INVOKE_CANCELLED) {
            void settleUnrequestedCancel(activeTurnId, err);
            return;
          }
          if (err.code === ERR_UNAUTHENTICATED) {
            // Not the turn's ending — the agent refused to show it. The turn
            // may well still be running there.
            setError(err.message);
            setStatus("error");
            const assistantId = assistantIdRef.current;
            if (assistantId) updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
            return;
          }
          setError(describeTurnError({ code: err.code, message: err.message }));
          setStatus("error");
          if (err.code !== undefined) {
            // The turn's own ending, recorded in its journal: shown on the
            // reply by code, as a reload would show it.
            setMessages((prev) => applyTurnError(prev, activeTurnId, { code: err.code, message: err.message }));
            return;
          }
          // A lost connection usually means the per-session container is gone —
          // drop it so the next send re-launches instead of failing forever.
          invalidateLaunched("event stream connection lost");
          const assistantId = assistantIdRef.current;
          if (assistantId) updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
        },
        onEnd: () => {
          void endTurn();
        },
      });
    },
    [applyStreamRecord, endTurn, invalidateLaunched, settleUnrequestedCancel, updateAssistant],
  );

  // Abort a turn this client started but will not follow — a Stop that landed
  // while the agent was admitting it. Nothing shows it, so a failure to abort is
  // reported rather than left as a turn running unseen.
  const abortUnattached = useCallback((c: AgentClient, turn: string) => {
    c.abortTurn(turn).catch((err: unknown) => {
      setError(`Failed to stop the turn: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, []);

  // ── send ────────────────────────────────────────────────────────────────────
  // The turn itself: reach an agent, seed the history and the workspace, start
  // the turn and attach its stream. Shared by a fresh send and by a retry —
  // what differs between them is the transcript bookkeeping, which stays with
  // each caller, since only they know whether a bubble is being appended or
  // replaced.
  // The open conversation as the selected agent knows it — adopted as that
  // agent's without touching the transcript on screen.
  const adoptConversation = useCallback(
    (next: Conversation, key: string) => {
      deferredResolveRef.current = false;
      supersedeResolution();
      conversationAgentRef.current = key;
      setConversationMeta(next);
      conversationIdRef.current = next.id;
      setConversationId(next.id);
      if (workspaceKeyRef.current) saveConversationId(workspaceKeyRef.current, next.id);
    },
    [setConversationMeta, supersedeResolution],
  );

  // Assigned below, once the resolver exists.
  const resolveOwnedRef = useRef<(workspaceKey: string, notice?: string, keepUnsent?: boolean) => Promise<void>>(
    async () => undefined,
  );

  // The conversation a send goes to, on the agent just selected. An agent that
  // serves conversations mints its ids: a draft is created there first, and an
  // id this agent has not confirmed is asked for — never replaced by a new
  // conversation: a gone one resolves the workspace again and the message stays
  // unsent (null). An older agent takes a client-minted id.
  const conversationForSend = useCallback(async (): Promise<string | null> => {
    const key = agentKey({ url: agentUrlRef.current, token: agentTokenRef.current });
    const current = conversationIdRef.current;
    if (current && conversationAgentRef.current === key) return current;
    const identity = await currentIdentity();
    const c = client();
    if (hasFeature(identity, AGENT_FEATURES.conversations)) {
      if (current) {
        try {
          const known = await c.conversation(current);
          adoptConversation(known, key);
          return known.id;
        } catch (err) {
          const gone = goneStatus(err);
          if (gone === null) throw err;
          const workspaceKey = workspaceKeyRef.current;
          if (workspaceKey) await resolveOwnedRef.current(workspaceKey, goneNotice(gone), true);
          return null;
        }
      }
      const created = await c.createConversation();
      adoptConversation(created, key);
      return created.id;
    }
    deferredResolveRef.current = false;
    if (current) return current;
    const minted = crypto.randomUUID();
    if (workspaceKeyRef.current) saveConversationId(workspaceKeyRef.current, minted);
    conversationIdRef.current = minted;
    setConversationId(minted);
    return minted;
  }, [adoptConversation, client, currentIdentity]);

  const dispatchTurn = useCallback(
    (text: string, userId: string, assistantId: string) => {
      const bridge = bridgeRef.current;
      if (!workspaceKeyRef.current || !bridge) return;
      setUnsent({ text, userId, assistantId });

      // A Stop click bumps the generation; the pipeline re-checks it after
      // every await so a superseded send can't resurrect the turn.
      const gen = ++sendGenRef.current;
      const superseded = () => sendGenRef.current !== gen;

      void (async () => {
        try {
          await ensureAgent();
          if (superseded()) return;
          const c = client();
          setStatus("seeding");
          const workspace = workspaceRef.current;
          if (!workspace) throw new Error("No agent workspace is reachable.");
          await seedDelta(workspace, bridge);
          if (superseded()) return;
          const convId = await conversationForSend();
          if (superseded()) return;
          if (convId === null) {
            setStatus("error");
            updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
            return;
          }
          const outcome = await c.startTurn(convId, text);
          if (superseded()) {
            // Stopped while the agent was admitting it: the turn exists now,
            // so it is aborted rather than left running unseen.
            if (outcome.kind === "started") abortUnattached(c, outcome.turnId);
            return;
          }
          if (outcome.kind === "refused") {
            if (outcome.status >= 502 && outcome.status <= 504) {
              invalidateLaunched(`POST /chat answered ${outcome.status}`);
            }
            setError(refusalMessage(outcome));
            setStatus("error");
            updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
            return;
          }
          // The bubbles take the turn's own ids, which the journal's records
          // are folded under — so its `user-message` record lands on the bubble
          // already shown rather than adding a second one.
          const turn = outcome.turnId;
          setUnsent(null);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === userId
                ? { ...m, id: userMessageId(turn), local: undefined }
                : m.id === assistantId
                  ? { ...m, id: turn, local: undefined }
                  : m,
            ),
          );
          assistantIdRef.current = turn;
          setTurnId(turn);
          setStatus("streaming");
          attachStream(turn, 0);
        } catch (err) {
          if (superseded()) return;
          if (isUpstreamGone(err)) {
            invalidateLaunched(err instanceof Error ? err.message : String(err));
          }
          if (err instanceof TermsRequiredError) {
            // The shell shows the agreement; the turn stays in the transcript as
            // a failed one, so accepting and retrying resumes this same request.
            termsGateRef.current?.(err.terms);
            setError("The runner requires accepting its usage terms before the agent can start.");
            setStatus("error");
            updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
            return;
          }
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
          updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
        }
      })();
    },
    [client, conversationForSend, ensureAgent, attachStream, invalidateLaunched, updateAssistant, abortUnattached],
  );

  const send = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text || lockedRef.current || !workspaceKeyRef.current || !bridgeRef.current) return;
      if (conversationRef.current?.archived) return;
      setError(null);
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text, local: true };
      const assistantId = crypto.randomUUID();
      assistantIdRef.current = assistantId;
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", parts: [], pending: true, local: true };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      dispatchTurn(text, userMsg.id, assistantId);
    },
    [dispatchTurn],
  );

  // ── resume ──────────────────────────────────────────────────────────────────

  // Continue an interrupted turn on the agent that holds it, inside the same
  // turn: the stream re-attaches from the last record this client folded, so
  // what the agent records next — the `turn-continued` divider, then the new
  // attempt — lands on the same reply. A turn still running (its stream was
  // lost, not its work) is attached to as it is.
  const continueTurn = useCallback(
    (turn: AssistantMessage) => {
      const bridge = bridgeRef.current;
      const agent = reachableAgent();
      if (!bridge) return;
      if (!agent) {
        setError("No agent holds this conversation any more — send your message again.");
        return;
      }
      const gen = ++sendGenRef.current;
      const superseded = () => sendGenRef.current !== gen;
      selectAgent(agent);
      const c = client();

      void (async () => {
        try {
          setStatus("seeding");
          await seedDelta(agent.workspace, bridge);
          if (superseded()) {
            setStatus("idle");
            return;
          }
          const outcome = await c.continueTurn(turn.id);
          const running =
            outcome.kind === "continued" ||
            (outcome.code === "ERR_TURN_IN_PROGRESS" && outcome.activeTurnId === turn.id);
          if (superseded()) {
            if (running) abortUnattached(c, turn.id);
            return;
          }
          if (outcome.kind === "refused" && !running) {
            if (outcome.status >= 502 && outcome.status <= 504) {
              invalidateLaunched(`POST /chat/${turn.id}/continue answered ${outcome.status}`);
            }
            setError(refusalMessage(outcome));
            setStatus("error");
            return;
          }
          assistantIdRef.current = turn.id;
          updateAssistant(turn.id, (m) => ({ ...m, pending: true, error: undefined, errorCode: undefined }));
          setTurnId(turn.id);
          setStatus("streaming");
          attachStream(turn.id, turn.lastRecordId ?? 0);
        } catch (err) {
          if (superseded()) return;
          if (isUpstreamGone(err)) invalidateLaunched(err instanceof Error ? err.message : String(err));
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      })();
    },
    [abortUnattached, attachStream, client, invalidateLaunched, reachableAgent, updateAssistant, selectAgent],
  );

  /**
   * Pick an interrupted turn back up. A message the agent never admitted is sent
   * again as it was; a turn the agent holds is continued there, never re-sent —
   * the agent has its every record, so the model resumes from exactly where it
   * stopped instead of from a summary of itself.
   */
  const retry = useCallback(() => {
    if (locked || !workspaceKeyRef.current || !bridgeRef.current) return;
    setError(null);
    const pendingSend = unsentRef.current;
    if (pendingSend) {
      assistantIdRef.current = pendingSend.assistantId;
      updateAssistant(pendingSend.assistantId, (m) => ({ ...m, pending: true, error: undefined, errorCode: undefined }));
      dispatchTurn(pendingSend.text, pendingSend.userId, pendingSend.assistantId);
      return;
    }
    const turn = interruptedTurn(messagesRef.current);
    if (turn) continueTurn(turn);
  }, [continueTurn, dispatchTurn, locked, updateAssistant]);

  // Stop: abort the running turn on the agent, so its model call and its tool
  // end and the workspace stops changing. The stream stays open: the turn's own
  // ERR_INVOKE_CANCELLED frame ends it, as Stopped, and the normal end-of-turn
  // convergence follows. Before the agent has admitted anything, the pipeline
  // starting it is superseded instead, and aborts the turn if it lands anyway.
  const stop = useCallback(() => {
    sendGenRef.current++;
    const activeTurn = turnIdRef.current;
    if (!activeTurn) {
      const pendingSend = unsentRef.current;
      if (pendingSend) {
        updateAssistant(pendingSend.assistantId, (m) => ({ ...m, pending: false, stopped: true }));
        setUnsent(null);
      }
      setStatus("idle");
      return;
    }
    stoppingRef.current = true;
    setStatus("stopping");
    client()
      .abortTurn(activeTurn)
      .then(
        (outcome) => {
          // Nothing was running any more: the turn reached its own ending, which
          // its stream delivers.
          if (!outcome.cancelled && stoppingRef.current) {
            stoppingRef.current = false;
            setStatus("streaming");
          }
        },
        (err: unknown) => {
          setError(`Failed to stop the turn: ${err instanceof Error ? err.message : String(err)}`);
          if (!stoppingRef.current) return;
          stoppingRef.current = false;
          setStatus("streaming");
        },
      );
  }, [client, updateAssistant]);

  // ── conversation switch (workspace load / reload) ──────────────────────────
  // Replace the transcript with the open conversation's records on the agent,
  // and re-attach to its last turn when that one is still running — from the
  // last record read. A bubble the agent never admitted stays below it.
  // Resolves `loaded` only when the transcript was replaced from the agent.
  const onGoneRef = useRef<(status: 404 | 410) => void>(() => undefined);
  const loadTranscript = useCallback(async (): Promise<"loaded" | "failed" | "skipped"> => {
    const convId = conversationIdRef.current;
    const agent = reachableAgent();
    if (!convId || !agent || turnIdRef.current) return "skipped";
    const agentClient = new AgentClient(agent.url, agent.token);
    try {
      const turns = await readConversation((cursor) => agentClient.records(convId, cursor));
      if (conversationIdRef.current !== convId || turnIdRef.current) return "skipped";
      setMessages((prev) => [...transcriptFromTurns(turns), ...prev.filter((m) => m.local)]);
      const last = turns[turns.length - 1];
      if (last?.status !== "running") return "loaded";
      selectAgent(agent);
      assistantIdRef.current = last.turnId;
      turnIdRef.current = last.turnId;
      setTurnId(last.turnId);
      setStatus("streaming");
      attachStream(last.turnId, last.records[last.records.length - 1]?.id ?? 0);
      return "loaded";
    } catch (err) {
      if (conversationIdRef.current !== convId) return "failed";
      const gone = goneStatus(err);
      if (gone !== null) {
        // Not known yet whether this agent serves conversations: the answer
        // resolves the workspace's conversation, this id included.
        if (identityRef.current === null) return "failed";
        if (hasFeature(identityRef.current, AGENT_FEATURES.conversations)) {
          onGoneRef.current(gone);
          return "failed";
        }
      }
      setError(`Failed to read the conversation from the agent: ${message(err)}`);
      return "failed";
    }
  }, [attachStream, reachableAgent, selectAgent]);
  onCoResidentRef.current = () => {
    void loadTranscript();
  };

  // Show `id` — or an empty draft for null — with nothing of the previous
  // conversation left: its stream detached, its transcript and error cleared.
  // `keepUnsent` keeps a message the agent never admitted, to be retried there.
  const switchTo = useCallback(
    (id: string | null, keepUnsent = false) => {
      streamRef.current?.close();
      streamRef.current = null;
      conversationIdRef.current = id;
      setConversationId(id);
      setError(null);
      setMessages(keepUnsent ? (prev) => prev.filter((m) => m.local) : []);
      assistantIdRef.current = null;
      turnIdRef.current = null;
      setTurnId(null);
      setStatus("idle");
      stoppingRef.current = false;
      staleRef.current = false;
      if (!keepUnsent) setUnsent(null);
      if (id) void loadTranscript();
    },
    [loadTranscript],
  );

  // Open a conversation the agent reported, as the workspace's last-opened one.
  // The one already open is adopted in place rather than re-read.
  const showOwned = useCallback(
    (next: Conversation, key: string, keepUnsent = false) => {
      const reopened = next.id === conversationIdRef.current;
      conversationAgentRef.current = key;
      setConversationMeta(next);
      if (workspaceKeyRef.current) saveConversationId(workspaceKeyRef.current, next.id);
      if (!reopened) switchTo(next.id, keepUnsent);
    },
    [setConversationMeta, switchTo],
  );

  const showDraft = useCallback(
    (keepUnsent = false) => {
      conversationAgentRef.current = null;
      setConversationMeta(null);
      switchTo(null, keepUnsent);
    },
    [setConversationMeta, switchTo],
  );

  // The workspace's conversation on an agent that serves conversations: the
  // last-opened one while the agent has it, else its most recent live one, else
  // a draft. `notice` says why the open one was left. Any failure other than
  // 404/410 leaves the workspace unresolved — the pointed conversation open but
  // not adopted, or a draft when there is no pointer — the pointer untouched,
  // and the resolution retried by the revision poll's tick. `keepUnsent` keeps
  // a message a send could not deliver.
  const resolveOwned = useCallback(
    async (workspaceKey: string, notice?: string, keepUnsent = false) => {
      const agent = reachableAgent();
      if (!agent) return;
      const key = agentKey(agent);
      const c = new AgentClient(agent.url, agent.token);
      const gen = ++resolveGenRef.current;
      const superseded = () => resolveGenRef.current !== gen || workspaceKeyRef.current !== workspaceKey;
      const retrying = unresolvedRef.current?.workspaceKey === workspaceKey;
      resolvingRef.current = true;
      const resolved = (switched: boolean) => {
        const failedBefore = resolveErrorRef.current;
        resolveErrorRef.current = null;
        markUnresolved(null);
        if (switched || failedBefore === null) {
          if (notice) setError(notice);
          return;
        }
        setError((current) => (current === failedBefore ? (notice ?? null) : current));
      };
      const failed = (err: unknown) => {
        const said = `${notice ? `${notice} ` : ""}Failed to open the workspace's conversation: ${message(err)}`;
        resolveErrorRef.current = said;
        markUnresolved({ workspaceKey, notice });
        setError(said);
      };
      // A retry leaves the draft it already shows — and a message kept in it — as it is.
      const draftShown = () => retrying && conversationIdRef.current === null;
      try {
        const pointer = loadConversationId(workspaceKey);
        if (pointer) {
          try {
            const known = await c.conversation(pointer);
            if (superseded()) return;
            const switched = known.id !== conversationIdRef.current;
            showOwned(known, key, keepUnsent);
            resolved(switched);
            return;
          } catch (err) {
            if (superseded()) return;
            if (goneStatus(err) === null) {
              conversationAgentRef.current = null;
              setConversationMeta(null);
              if (conversationIdRef.current !== pointer) switchTo(pointer, keepUnsent);
              failed(err);
              return;
            }
          }
        }
        try {
          const page = await c.listConversations({ limit: 1, archived: false });
          if (superseded()) return;
          const recent = page.conversations[0];
          if (recent) {
            const switched = recent.id !== conversationIdRef.current;
            showOwned(recent, key, keepUnsent);
            resolved(switched);
            return;
          }
          const switched = !draftShown();
          if (switched) showDraft(keepUnsent);
          resolved(switched);
        } catch (err) {
          if (superseded()) return;
          if (!draftShown()) showDraft(keepUnsent);
          failed(err);
        }
      } finally {
        if (resolveGenRef.current === gen) resolvingRef.current = false;
      }
    },
    [markUnresolved, reachableAgent, setConversationMeta, showDraft, showOwned, switchTo],
  );
  resolveOwnedRef.current = resolveOwned;

  // Set while this client deletes a conversation: its own 410 is not news.
  const deletingRef = useRef<string | null>(null);
  onGoneRef.current = (gone) => {
    const workspaceKey = workspaceKeyRef.current;
    if (!workspaceKey || deletingRef.current === conversationIdRef.current) return;
    void resolveOwned(workspaceKey, goneNotice(gone));
  };

  // The workspace's conversation, once it is known what the agent serves. An
  // agent not asked yet, or one that predates conversations, gets the stored id
  // as it always did — minted when there is none, unless the answer is on its
  // way, in which case a draft waits for it.
  const resolveWorkspace = useCallback(
    (workspaceKey: string) => {
      const agent = reachableAgent();
      const identityNow = identityRef.current;
      const pending = agent !== null && (identityKeyRef.current !== agentKey(agent) || identityNow === null);
      deferredResolveRef.current = false;
      markUnresolved(null);
      resolveErrorRef.current = null;
      if (agent && !pending && hasFeature(identityNow, AGENT_FEATURES.conversations)) {
        void resolveOwned(workspaceKey);
        return;
      }
      conversationAgentRef.current = null;
      setConversationMeta(null);
      const stored = loadConversationId(workspaceKey);
      if (stored) {
        switchTo(stored);
        return;
      }
      if (pending) {
        deferredResolveRef.current = true;
        switchTo(null);
        return;
      }
      const minted = crypto.randomUUID();
      saveConversationId(workspaceKey, minted);
      switchTo(minted);
    },
    [markUnresolved, reachableAgent, resolveOwned, setConversationMeta, switchTo],
  );

  onIdentityRef.current = () => {
    const workspaceKey = workspaceKeyRef.current;
    const agent = reachableAgent();
    // A send in flight settles its own conversation against this answer.
    const sending = statusRef.current === "launching" || statusRef.current === "seeding";
    if (!workspaceKey || !agent || sending) return;
    if (deferredResolveRef.current) {
      resolveWorkspace(workspaceKey);
      return;
    }
    const on = hasFeature(identityRef.current, AGENT_FEATURES.conversations);
    if (on && conversationAgentRef.current !== agentKey(agent)) void resolveOwned(workspaceKey);
    else if (!on && conversationRef.current) resolveWorkspace(workspaceKey);
  };

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const setConversation = useCallback(
    (key: string | null) => {
      workspaceKeyRef.current = key;
      setWorkspaceOpen(key !== null);
      if (!key) {
        deferredResolveRef.current = false;
        supersedeResolution();
        conversationAgentRef.current = null;
        setConversationMeta(null);
        streamRef.current?.close();
        streamRef.current = null;
        conversationIdRef.current = null;
        setConversationId(null);
        setMessages([]);
        setTurnId(null);
        setStatus("idle");
        setError(null);
        return;
      }
      resolveWorkspace(key);
    },
    [resolveWorkspace, setConversationMeta, supersedeResolution],
  );

  const clearConversation = useCallback(() => {
    const key = workspaceKeyRef.current;
    if (!key) return;
    if (hasFeature(identityRef.current, AGENT_FEATURES.conversations)) {
      // The current conversation stays the agent's, listed; the draft becomes
      // one on its first send.
      showDraft();
      return;
    }
    // Detach any live turn client-side; the server turn is orphaned under the
    // old id and its journal is no longer read.
    const next = crypto.randomUUID();
    saveConversationId(key, next);
    conversationAgentRef.current = null;
    setConversationMeta(null);
    switchTo(next);
  }, [setConversationMeta, showDraft, switchTo]);

  // ── other clients ───────────────────────────────────────────────────────────
  // Another client's turn, rename, archive, truncation or deletion moves the
  // conversation's revision; the transcript is re-read when it moved — never
  // under a turn of this client's, which re-reads once its stream ends.
  const pollingRef = useRef(false);
  const pollErrorRef = useRef<string | null>(null);
  const pollConversation = useCallback(async (): Promise<boolean> => {
    const id = conversationIdRef.current;
    const agent = reachableAgent();
    if (!id || !agent || pollingRef.current || conversationAgentRef.current !== agentKey(agent)) return false;
    pollingRef.current = true;
    try {
      const next = await new AgentClient(agent.url, agent.token).conversation(id);
      if (conversationIdRef.current !== id) return false;
      const failedBefore = pollErrorRef.current;
      if (failedBefore) {
        pollErrorRef.current = null;
        setError((current) => (current === failedBefore ? null : current));
      }
      const previous = conversationRef.current;
      setConversationMeta(next);
      if (previous && previous.revision === next.revision) return false;
      if (lockedRef.current || turnIdRef.current) {
        staleRef.current = true;
        return false;
      }
      await loadTranscript();
      return true;
    } catch (err) {
      if (conversationIdRef.current !== id) return false;
      const gone = goneStatus(err);
      if (gone !== null) {
        onGoneRef.current(gone);
        return false;
      }
      const said = `Failed to check the conversation for changes: ${message(err)}`;
      pollErrorRef.current = said;
      setError(said);
      return false;
    } finally {
      pollingRef.current = false;
    }
  }, [loadTranscript, reachableAgent, setConversationMeta]);

  afterTurnRef.current = () => {
    const stale = staleRef.current;
    staleRef.current = false;
    void pollConversation().then((reloaded) => {
      if (stale && !reloaded) void loadTranscript();
    });
  };

  // An unresolved workspace retries its resolution in the poll's slot instead.
  useEffect(() => {
    if (!panelOpen || !conversationsOn || (!conversationId && !unresolved)) return;
    const tick = () => {
      // A resolution in flight owns the slot.
      if (document.visibilityState !== "visible" || resolvingRef.current) return;
      const pending = unresolvedRef.current;
      if (!pending) {
        void pollConversation();
        return;
      }
      if (lockedRef.current || workspaceKeyRef.current !== pending.workspaceKey) return;
      void resolveOwned(pending.workspaceKey, pending.notice);
    };
    const timer = setInterval(tick, CONVERSATION_POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [panelOpen, conversationsOn, conversationId, unresolved, pollConversation, resolveOwned]);

  // ── conversation operations ─────────────────────────────────────────────────
  const agentClientOrThrow = useCallback((): { agent: ReachableAgent; client: AgentClient } => {
    const agent = reachableAgent();
    if (!agent) throw new Error("No agent is reachable.");
    return { agent, client: new AgentClient(agent.url, agent.token) };
  }, [reachableAgent]);

  const listConversations = useCallback<AgentContextValue["listConversations"]>(
    (query) => agentClientOrThrow().client.listConversations(query),
    [agentClientOrThrow],
  );

  const openListed = useCallback(
    (next: Conversation) => {
      const agent = reachableAgent();
      if (!agent || next.id === conversationIdRef.current) return;
      // The user's choice settles the workspace's conversation.
      supersedeResolution();
      showOwned(next, agentKey(agent));
    },
    [reachableAgent, showOwned, supersedeResolution],
  );

  const updateConversation = useCallback(
    async (id: string, change: { title?: string; archived?: boolean }) => {
      const updated = await agentClientOrThrow().client.updateConversation(id, change);
      if (conversationIdRef.current === id) setConversationMeta(updated);
    },
    [agentClientOrThrow, setConversationMeta],
  );
  const renameConversation = useCallback(
    (id: string, title: string) => updateConversation(id, { title }),
    [updateConversation],
  );
  const setConversationArchived = useCallback(
    (id: string, archived: boolean) => updateConversation(id, { archived }),
    [updateConversation],
  );

  const deleteConversation = useCallback(
    async (id: string, stopRunning: boolean): Promise<"deleted" | "running"> => {
      const { agent, client: c } = agentClientOrThrow();
      const running = id === conversationIdRef.current ? turnIdRef.current : null;
      if (running && !stopRunning) return "running";
      deletingRef.current = id;
      try {
        if (running) {
          stop();
          await waitForTurnEnd(agent.url, agent.token, running);
        }
        try {
          await c.deleteConversation(id);
        } catch (err) {
          if (!(err instanceof AgentRequestError) || err.code !== ERR_TURN_IN_PROGRESS || !err.activeTurnId) throw err;
          if (!stopRunning) return "running";
          await c.abortTurn(err.activeTurnId);
          await waitForTurnEnd(agent.url, agent.token, err.activeTurnId);
          await c.deleteConversation(id);
        }
        const workspaceKey = workspaceKeyRef.current;
        if (id === conversationIdRef.current && workspaceKey) await resolveOwned(workspaceKey);
        return "deleted";
      } finally {
        deletingRef.current = null;
      }
    },
    [agentClientOrThrow, resolveOwned, stop],
  );

  const exportConversation = useCallback(
    async (id: string, format: "markdown" | "json"): Promise<ConversationDownload> => {
      const identityNow = identityRef.current;
      if (identityNow?.state !== "known") throw new Error("The agent's identity is not known — it cannot be exported.");
      const { client: c } = agentClientOrThrow();
      const [exported, turns] = await Promise.all([
        c.conversation(id),
        readConversation((cursor) => c.records(id, cursor)),
      ]);
      const base = `${(exported.title ?? "conversation").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "conversation"}-${id.slice(0, 8)}`;
      return format === "json"
        ? { filename: `${base}.json`, content: exportJson(identityNow.identity, exported, turns), type: "application/json" }
        : { filename: `${base}.md`, content: exportMarkdown(exported, turns), type: "text/markdown" };
    },
    [agentClientOrThrow],
  );

  // Re-read a conversation that moved on: its state, then its transcript. True
  // only when both were read, so nothing is asked again against a stale view.
  const reread = useCallback(
    async (c: AgentClient, id: string): Promise<boolean> => {
      try {
        const next = await c.conversation(id);
        if (conversationIdRef.current !== id) return false;
        setConversationMeta(next);
        const transcript = await loadTranscript();
        if (transcript === "skipped" && conversationIdRef.current === id) {
          setError("The conversation changed and could not be read again; nothing was repeated.");
        }
        return transcript === "loaded";
      } catch (err) {
        if (conversationIdRef.current === id) setError(`Failed to re-read the conversation: ${message(err)}`);
        return false;
      }
    },
    [loadTranscript, setConversationMeta],
  );

  // A turn action's failure: a conversation gone is left, one that moved on is
  // re-read (`changed` only when the re-read succeeded), anything else is shown
  // with its code.
  const actionFailed = useCallback(
    async (c: AgentClient, id: string, err: unknown): Promise<TurnActionOutcome> => {
      if (conversationIdRef.current !== id) return "failed";
      const gone = goneStatus(err);
      if (gone !== null) {
        onGoneRef.current(gone);
        return "failed";
      }
      if (err instanceof AgentRequestError && err.code === ERR_CONVERSATION_CHANGED) {
        return (await reread(c, id)) ? "changed" : "failed";
      }
      setError(message(err));
      return "failed";
    },
    [reread],
  );

  const truncateFrom = useCallback(
    async (turn: string): Promise<TurnActionOutcome> => {
      const id = conversationIdRef.current;
      const current = conversationRef.current;
      const agent = reachableAgent();
      if (!id || !current || !agent || lockedRef.current) return "failed";
      const c = new AgentClient(agent.url, agent.token);
      try {
        const { conversation: next } = await c.truncateConversation(id, turn, current.revision);
        if (conversationIdRef.current !== id) return "failed";
        setConversationMeta(next);
        setMessages((prev) => dropTurnsFrom(prev, turn));
        setUnsent(null);
        setError(null);
        return "done";
      } catch (err) {
        return actionFailed(c, id, err);
      }
    },
    [actionFailed, reachableAgent, setConversationMeta],
  );

  const resendFrom = useCallback(
    async (turn: string, text: string): Promise<TurnActionOutcome> => {
      const outcome = await truncateFrom(turn);
      if (outcome === "done") send(text);
      return outcome;
    },
    [send, truncateFrom],
  );

  const branchFrom = useCallback(
    async (turn: string) => {
      const id = conversationIdRef.current;
      const agent = reachableAgent();
      if (!id || !agent || lockedRef.current) return;
      const c = new AgentClient(agent.url, agent.token);
      try {
        const branch = await c.branchConversation(id, turn);
        if (conversationIdRef.current !== id) return;
        // The agent just answered for the branch: it is the workspace's, and a
        // resolution still in flight must not switch back to the old pointer.
        supersedeResolution();
        showOwned(branch, agentKey(agent));
      } catch (err) {
        if ((await actionFailed(c, id, err)) === "changed") setError(message(err));
      }
    },
    [actionFailed, reachableAgent, showOwned, supersedeResolution],
  );

  useEffect(
    () => () => {
      streamRef.current?.close();
      void launchedRef.current?.stop();
    },
    [],
  );

  // Tab/window close never runs the React cleanup above — fire a keepalive
  // DELETE on pagehide so the per-session container doesn't leak on the runner.
  // (sendBeacon can't send DELETE; a keepalive fetch survives page teardown.)
  useEffect(() => {
    const onPageHide = () => {
      const launched = launchedRef.current;
      if (!launched) return;
      // The page is going away — there is no surface left to report a failure to.
      void fetch(launched.deleteUrl, { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const value: AgentContextValue = {
    panelOpen,
    togglePanel,
    overrideUrl,
    setOverrideUrl,
    overrideToken,
    setOverrideToken,
    identity,
    questionCards,
    setQuestionCards,
    panelWidth,
    setPanelWidth,
    conversationId,
    messages,
    status,
    locked,
    error,
    send,
    stop,
    retry,
    canRetry: !locked && (unsent !== null || interruptedTurn(messages) !== null),
    clearConversation,
    features: {
      conversations: conversationsOn,
      truncation: conversationsOn && hasFeature(identity, AGENT_FEATURES.truncation),
      branching: conversationsOn && hasFeature(identity, AGENT_FEATURES.branching),
    },
    conversation,
    draft: workspaceOpen && conversationId === null,
    listConversations,
    openConversation: openListed,
    renameConversation,
    setConversationArchived,
    deleteConversation,
    exportConversation,
    truncateFrom,
    resendFrom,
    branchFrom,
    setConversation,
    registerWorkspace,
    setRunner,
    setCoResidentAgent,
    setRunnerAcceptedTerms,
    registerTermsGate,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
