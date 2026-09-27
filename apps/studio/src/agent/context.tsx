import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AgentClient,
  openAgentStream,
  type AgentStreamError,
  type AgentStreamHandle,
  type TurnRefused,
} from "./client";
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
  parseToolContent,
  readConversation,
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
  AgentStatus,
  AgentWorkspace,
  AssistantMessage,
  ChatMessage,
  CoResidentAgent,
  JournalRecord,
  ToolResult,
  WorkspaceBridge,
} from "./types";

interface AgentContextValue {
  // Panel + connection settings.
  panelOpen: boolean;
  togglePanel: () => void;
  /** Dev override URL; empty means launch a per-session agent on the runner. */
  overrideUrl: string;
  setOverrideUrl: (url: string) => void;
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
  /** Discard the current thread and start a fresh conversation for this
   *  workspace — clears the panel and gives the agent an empty history. */
  clearConversation: () => void;

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
    default:
      return refusal.message;
  }
}

/** How a turn's stream ends when its running attempt was cancelled. */
const ERR_INVOKE_CANCELLED = "ERR_INVOKE_CANCELLED";

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
  const [questionCards, setQuestionCards] = useState(initialSettings.current.questionCards);
  const [panelWidth, setPanelWidth] = useState(initialSettings.current.panelWidth);

  const [conversationId, setConversationId] = useState<string | null>(null);
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
  const overrideRef = useRef(overrideUrl);
  overrideRef.current = overrideUrl;
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

  const client = useCallback(() => new AgentClient(agentUrlRef.current), []);

  // Drop a launched per-session instance whose upstream looks gone (reaped
  // container, dead proxy route): the next send re-launches instead of failing
  // forever against a cached URL. Fires a best-effort DELETE so a container
  // that is in fact still alive doesn't leak on the runner.
  const invalidateLaunched = useCallback((reason: string) => {
    const launched = launchedRef.current;
    if (!launched) return;
    launchedRef.current = null;
    agentUrlRef.current = "";
    console.warn(`Dropping agent session '${launched.sessionId}': ${reason}`);
    void launched.stop();
  }, []);

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
    if (overrideRef.current) {
      agentUrlRef.current = overrideRef.current;
      workspaceRef.current = ownWorkspace(new AgentClient(overrideRef.current));
      return;
    }
    const coResident = coResidentRef.current;
    if (coResident) {
      if (launchedRef.current) {
        const stale = launchedRef.current;
        launchedRef.current = null;
        void stale.stop();
      }
      agentUrlRef.current = coResident.baseUrl;
      workspaceRef.current = coResident.workspace;
      return;
    }
    if (launchedRef.current) {
      agentUrlRef.current = launchedRef.current.agentUrl;
      workspaceRef.current = ownWorkspace(new AgentClient(launchedRef.current.agentUrl));
      return;
    }
    if (!runnerBaseRef.current) {
      throw new Error("No runner selected — pick a runner in settings, or set a dev agent URL.");
    }
    setStatus("launching");
    const launched = await launchAgentSession(runnerBaseRef.current, runnerTermsRef.current);
    launchedRef.current = launched;
    agentUrlRef.current = launched.agentUrl;
    workspaceRef.current = ownWorkspace(new AgentClient(launched.agentUrl));
  }, []);

  // ── persistence ───────────────────────────────────────────────────────────
  useEffect(() => {
    saveAgentSettings({ overrideUrl, panelOpen, questionCards, panelWidth });
  }, [overrideUrl, panelOpen, panelWidth, questionCards]);

  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);
  const setOverrideUrl = useCallback((url: string) => setOverrideUrlState(url), []);
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
    // Eager reflection: pull the one file the agent just wrote.
    if (record.data.type !== "tool-result") return;
    const raw = (record.data as { toolResult?: ToolResult }).toolResult;
    const path = parseToolContent(raw?.content)?.path;
    const bridge = bridgeRef.current;
    const workspace = workspaceRef.current;
    if (raw && path && bridge && workspace && (raw.name === "write_file" || raw.name === "edit_file")) {
      void pullFile(workspace, bridge, path).catch((err) => {
        // Mid-turn reflection is redone by the end-of-turn reconcile — log so
        // the failure isn't invisible in the meantime.
        console.error(`Failed to pull '${path}' from the agent workspace`, err);
      });
    }
  }, []);

  const endTurn = useCallback(async () => {
    const bridge = bridgeRef.current;
    const workspace = workspaceRef.current;
    stoppingRef.current = false;
    setStatus("idle");
    setTurnId(null);
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
  const dispatchTurn = useCallback(
    (text: string, userId: string, assistantId: string) => {
      const convId = conversationIdRef.current;
      const bridge = bridgeRef.current;
      if (!convId || !bridge) return;
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
              m.id === userId ? { ...m, id: userMessageId(turn) } : m.id === assistantId ? { ...m, id: turn } : m,
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
    [client, ensureAgent, attachStream, invalidateLaunched, updateAssistant, abortUnattached],
  );

  const send = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text || locked || !conversationIdRef.current || !bridgeRef.current) return;
      setError(null);
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text };
      const assistantId = crypto.randomUUID();
      assistantIdRef.current = assistantId;
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", parts: [], pending: true };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      dispatchTurn(text, userMsg.id, assistantId);
    },
    [dispatchTurn, locked],
  );

  // ── resume ──────────────────────────────────────────────────────────────────
  // The agent to read a conversation's records from — and to continue its turn
  // on — right now, without launching one: a launched per-session instance is
  // new, so it holds none.
  const reachableAgent = useCallback((): { url: string; workspace: AgentWorkspace } | null => {
    if (overrideRef.current) {
      return { url: overrideRef.current, workspace: ownWorkspace(new AgentClient(overrideRef.current)) };
    }
    const coResident = coResidentRef.current;
    if (coResident) return { url: coResident.baseUrl, workspace: coResident.workspace };
    const launched = launchedRef.current;
    if (launched) return { url: launched.agentUrl, workspace: ownWorkspace(new AgentClient(launched.agentUrl)) };
    return null;
  }, []);

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
      agentUrlRef.current = agent.url;
      workspaceRef.current = agent.workspace;
      const c = new AgentClient(agent.url);

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
    [abortUnattached, attachStream, invalidateLaunched, reachableAgent, updateAssistant],
  );

  /**
   * Pick an interrupted turn back up. A message the agent never admitted is sent
   * again as it was; a turn the agent holds is continued there, never re-sent —
   * the agent has its every record, so the model resumes from exactly where it
   * stopped instead of from a summary of itself.
   */
  const retry = useCallback(() => {
    if (locked || !conversationIdRef.current || !bridgeRef.current) return;
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
  // Read the open conversation back from the agent's records, and re-attach to
  // its last turn when that one is still running — from the last record read.
  const loadTranscript = useCallback(async () => {
    const convId = conversationIdRef.current;
    const agent = reachableAgent();
    if (!convId || !agent || turnIdRef.current) return;
    const agentClient = new AgentClient(agent.url);
    try {
      const turns = await readConversation((cursor) => agentClient.records(convId, cursor));
      if (conversationIdRef.current !== convId || turnIdRef.current) return;
      setMessages(transcriptFromTurns(turns));
      const last = turns[turns.length - 1];
      if (last?.status !== "running") return;
      agentUrlRef.current = agent.url;
      workspaceRef.current = agent.workspace;
      assistantIdRef.current = last.turnId;
      setTurnId(last.turnId);
      setStatus("streaming");
      attachStream(last.turnId, last.records[last.records.length - 1]?.id ?? 0);
    } catch (err) {
      if (conversationIdRef.current !== convId) return;
      setError(`Failed to read the conversation from the agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [attachStream, reachableAgent]);
  onCoResidentRef.current = () => {
    void loadTranscript();
  };

  const openConversation = useCallback(
    (effectiveId: string) => {
      streamRef.current?.close();
      streamRef.current = null;
      conversationIdRef.current = effectiveId;
      setConversationId(effectiveId);
      setError(null);
      setMessages([]);
      assistantIdRef.current = null;
      turnIdRef.current = null;
      setTurnId(null);
      setStatus("idle");
      stoppingRef.current = false;
      setUnsent(null);
      void loadTranscript();
    },
    [loadTranscript],
  );

  const setConversation = useCallback(
    (key: string | null) => {
      workspaceKeyRef.current = key;
      if (!key) {
        streamRef.current?.close();
        streamRef.current = null;
        setConversationId(null);
        setMessages([]);
        setTurnId(null);
        setStatus("idle");
        setError(null);
        return;
      }
      // The conversation id is a UUID (the agent keys its history by it), mapped
      // per-workspace and persisted so a reload restores the same thread. Mint
      // one on first use for this workspace.
      let id = loadConversationId(key);
      if (!id) {
        id = crypto.randomUUID();
        saveConversationId(key, id);
      }
      openConversation(id);
    },
    [openConversation],
  );

  const clearConversation = useCallback(() => {
    const key = workspaceKeyRef.current;
    if (!key) return;
    // Detach any live turn client-side; the server turn is orphaned under the
    // old id and its journal is no longer read.
    streamRef.current?.close();
    streamRef.current = null;
    assistantIdRef.current = null;
    // Mint a fresh UUID — a new conversation the agent has no records for.
    const next = crypto.randomUUID();
    saveConversationId(key, next);
    openConversation(next);
  }, [openConversation]);

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
    setConversation,
    registerWorkspace,
    setRunner,
    setCoResidentAgent,
    setRunnerAcceptedTerms,
    registerTermsGate,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
