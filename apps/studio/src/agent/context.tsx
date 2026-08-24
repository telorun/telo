import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AgentClient, openAgentStream, type AgentStreamHandle } from "./client";
import { launchAgentSession, type LaunchedAgent } from "./launch";
import { reconcile, seedDelta, pullFile } from "./sync";
import {
  clearChat,
  loadAgentSettings,
  loadChat,
  loadConversationId,
  saveAgentSettings,
  saveChat,
  saveConversationId,
} from "./storage";
import type {
  AgentHistoryRow,
  AgentStatus,
  AgentStreamPart,
  ChatMessage,
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

  // Conversation state.
  conversationId: string | null;
  messages: ChatMessage[];
  status: AgentStatus;
  /** Manual mutation is disabled while a turn is in flight. */
  locked: boolean;
  error: string | null;

  send: (message: string) => void;
  stop: () => void;
  /** Discard the current thread and start a fresh conversation for this
   *  workspace — clears the panel and gives the agent an empty history. */
  clearConversation: () => void;

  // Wiring from the editor shell.
  setConversation: (id: string | null) => void;
  registerWorkspace: (bridge: WorkspaceBridge | null) => void;
  /** The active runner's base URL, used to launch a per-session agent. */
  setRunner: (baseUrl: string | null) => void;
  /** The runner's terms version the user has accepted (null when the runner
   *  has no terms or they aren't accepted yet) — sent on the agent launch so
   *  a terms-enforcing runner doesn't 428 it. */
  setRunnerAcceptedTerms: (version: string | null) => void;
}

/** Recover a tool result's structured fields from its `content`. Tool outputs
 *  are `MessageContent` (a string); object outputs like write_file's
 *  `{ path, checkExitCode, checkOutput }` arrive JSON-stringified. */
function parseToolContent(
  content: unknown,
): { path?: string; checkExitCode?: number; checkOutput?: string } | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const obj = JSON.parse(content);
    return obj && typeof obj === "object" ? obj : undefined;
  } catch {
    return undefined;
  }
}

/** Heuristic for "the per-session container is gone": a network-level fetch
 *  failure, or a gateway error from the proxy fronting a dead upstream. Used to
 *  decide when a cached launch should be dropped and re-created. */
function isUpstreamGone(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network failure
  const message = err instanceof Error ? err.message : String(err);
  return /\((502|503|504)\)/.test(message);
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent() called outside <AgentProvider>");
  return ctx;
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const initialSettings = useRef(loadAgentSettings());
  const [panelOpen, setPanelOpen] = useState(initialSettings.current.panelOpen);
  const [overrideUrl, setOverrideUrlState] = useState(initialSettings.current.overrideUrl);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [turnId, setTurnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The agent-persisted history rows (the MODEL's view of the conversation),
  // snapshotted after each turn. A fresh per-session container starts with an
  // empty DB, so these rows are seeded back before its first turn — without
  // this the panel shows continuity while the model has amnesia.
  const [history, setHistory] = useState<AgentHistoryRow[]>([]);

  const bridgeRef = useRef<WorkspaceBridge | null>(null);
  const streamRef = useRef<AgentStreamHandle | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef<number>(0);
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
  const launchedRef = useRef<LaunchedAgent | null>(null);
  const historyRef = useRef<AgentHistoryRow[]>([]);
  historyRef.current = history;
  // `<sessionKey>:<conversationId>` pairs already seeded with history — one
  // import per session is enough (and the import is idempotent regardless).
  const historySeededRef = useRef<Set<string>>(new Set());

  const locked = status === "launching" || status === "seeding" || status === "streaming";

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

  // Ensure an agent instance is reachable: the dev override if set, else launch
  // (once) a per-session instance on the active runner. Sets `agentUrlRef`.
  const ensureAgent = useCallback(async () => {
    if (overrideRef.current) {
      agentUrlRef.current = overrideRef.current;
      return;
    }
    if (launchedRef.current) {
      agentUrlRef.current = launchedRef.current.agentUrl;
      return;
    }
    if (!runnerBaseRef.current) {
      throw new Error("No runner selected — pick a runner in settings, or set a dev agent URL.");
    }
    setStatus("launching");
    const launched = await launchAgentSession(runnerBaseRef.current, runnerTermsRef.current);
    launchedRef.current = launched;
    agentUrlRef.current = launched.agentUrl;
  }, []);

  // ── persistence ───────────────────────────────────────────────────────────
  useEffect(() => {
    saveAgentSettings({ overrideUrl, panelOpen });
  }, [overrideUrl, panelOpen]);

  // Identity of the agent session the current turn runs on — a persisted turn
  // may only be re-attached against the same session (see PersistedChat).
  const agentSessionKey = useCallback(
    () =>
      overrideRef.current
        ? `override:${overrideRef.current}`
        : (launchedRef.current?.sessionId ?? null),
    [],
  );

  useEffect(() => {
    if (!conversationId) return;
    saveChat(conversationId, {
      messages,
      activeTurnId: turnId,
      lastEventId: lastEventIdRef.current,
      agentSession: turnId ? agentSessionKey() : null,
      history,
    });
  }, [agentSessionKey, conversationId, history, messages, turnId]);

  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);
  const setOverrideUrl = useCallback((url: string) => setOverrideUrlState(url), []);
  const registerWorkspace = useCallback((bridge: WorkspaceBridge | null) => {
    bridgeRef.current = bridge;
  }, []);
  const setRunner = useCallback((base: string | null) => {
    runnerBaseRef.current = base;
  }, []);
  const setRunnerAcceptedTerms = useCallback((version: string | null) => {
    runnerTermsRef.current = version;
  }, []);

  const updateAssistant = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  // ── stream part → transcript ────────────────────────────────────────────────
  const applyPart = useCallback(
    (part: AgentStreamPart, id: number) => {
      lastEventIdRef.current = id;
      const assistantId = assistantIdRef.current;
      if (!assistantId) return;

      switch (part.type) {
        case "text-delta": {
          const delta = typeof (part as { delta?: unknown }).delta === "string" ? (part as { delta: string }).delta : "";
          updateAssistant(assistantId, (m) => ({ ...m, text: m.text + delta }));
          break;
        }
        case "tool-call": {
          // Ai.AgentStream tool-call shape: { toolCall: { id, name, arguments } }.
          const call = (part as { toolCall?: { id?: string; name?: string; arguments?: unknown } }).toolCall ?? {};
          const toolCallId = call.id ?? `${call.name ?? "tool"}-${Math.floor(id)}`;
          updateAssistant(assistantId, (m) => ({
            ...m,
            tools: [
              ...m.tools,
              { toolCallId, name: call.name ?? "tool", args: call.arguments, state: "running" },
            ],
          }));
          break;
        }
        case "tool-result": {
          // Ai.AgentStream tool-result shape: { toolResult: { toolCallId, name,
          // content, error? } }. `content` is a string; structured tool outputs
          // (write_file / edit_file) are JSON-stringified, so parse to recover the
          // path and the auto-`telo check` verdict.
          const raw = (part as { toolResult?: ToolResult }).toolResult;
          if (!raw) break;
          const failed = raw.error === true;
          const parsed = parseToolContent(raw.content);
          const checkExitCode = parsed?.checkExitCode;
          const checkOutput = parsed?.checkOutput;
          updateAssistant(assistantId, (m) => ({
            ...m,
            tools: m.tools.map((t) =>
              t.state === "running" && (raw.toolCallId ? t.toolCallId === raw.toolCallId : t.name === raw.name)
                ? { ...t, state: failed ? "error" : "done", output: raw.content, checkExitCode, checkOutput }
                : t,
            ),
          }));
          // Eager reflection: pull the one file the agent just wrote.
          const path = parsed?.path;
          const bridge = bridgeRef.current;
          if (path && bridge && (raw.name === "write_file" || raw.name === "edit_file")) {
            void pullFile(client(), bridge, path).catch((err) => {
              // Mid-turn reflection is redone by the end-of-turn reconcile —
              // log so the failure isn't invisible in the meantime.
              console.error(`Failed to pull '${path}' from the agent workspace`, err);
            });
          }
          break;
        }
        case "error": {
          const message =
            typeof (part as { message?: unknown }).message === "string"
              ? (part as { message: string }).message
              : "agent error";
          updateAssistant(assistantId, (m) => ({ ...m, error: message, pending: false }));
          break;
        }
        case "finish": {
          updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
          break;
        }
      }
    },
    [client, updateAssistant],
  );

  const endTurn = useCallback(async () => {
    const bridge = bridgeRef.current;
    setStatus("idle");
    setTurnId(null);
    if (bridge) {
      try {
        await reconcile(client(), bridge);
      } catch (err) {
        // The next turn re-seeds, but the user must know the editor may be
        // showing stale files right now.
        setError(
          `Failed to reflect the agent's workspace changes into the editor: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Snapshot the agent-persisted history rows — the durable copy a later
    // session gets seeded with (the container itself is ephemeral).
    const convId = conversationIdRef.current;
    if (convId && agentUrlRef.current) {
      try {
        setHistory(await client().conversation(convId));
      } catch (err) {
        setError(
          `Failed to snapshot the conversation history from the agent: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }, [client]);

  const attachStream = useCallback(
    (activeTurnId: string, fromId: number) => {
      streamRef.current?.close();
      streamRef.current = openAgentStream({
        baseUrl: agentUrlRef.current,
        turnId: activeTurnId,
        fromId,
        onPart: applyPart,
        onError: (err) => {
          // A lost connection usually means the per-session container is gone —
          // drop it so the next send re-launches instead of failing forever.
          if (err.message === "agent stream connection lost") {
            invalidateLaunched("event stream connection lost");
          }
          setError(err.message);
          setStatus("error");
          const assistantId = assistantIdRef.current;
          if (assistantId) updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
        },
        onEnd: () => {
          void endTurn();
        },
      });
    },
    [applyPart, endTurn, invalidateLaunched, updateAssistant],
  );

  // ── send ────────────────────────────────────────────────────────────────────
  const send = useCallback(
    (message: string) => {
      const convId = conversationIdRef.current;
      const bridge = bridgeRef.current;
      const text = message.trim();
      if (!text || locked || !convId || !bridge) return;

      setError(null);
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text, tools: [] };
      const assistantId = crypto.randomUUID();
      assistantIdRef.current = assistantId;
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", text: "", tools: [], pending: true };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      lastEventIdRef.current = 0;

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
          // Seed conversation history once per (session, conversation): a fresh
          // per-session container has an empty DB, so without this the model
          // would see none of the conversation the panel shows. Idempotent
          // server-side (INSERT OR IGNORE by row id).
          const seedKey = `${agentSessionKey()}:${convId}`;
          if (historyRef.current.length > 0 && !historySeededRef.current.has(seedKey)) {
            await c.importMessages(convId, historyRef.current);
            historySeededRef.current.add(seedKey);
          }
          if (superseded()) return;
          await seedDelta(c, bridge);
          if (superseded()) return;
          const outcome = await c.startTurn(convId, text);
          if (superseded()) return;
          if (outcome.kind === "denied") {
            setError(`At capacity — try again${outcome.retryAfter ? ` in ${outcome.retryAfter}s` : ""}.`);
            setStatus("error");
            updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
            return;
          }
          if (outcome.kind === "conflict") {
            if (outcome.activeTurnId) {
              // One conversation per workspace, so an in-flight turn is our own
              // — typically the retry of a POST whose first attempt landed.
              // Attach to it instead of erroring; the replay fills this bubble.
              setTurnId(outcome.activeTurnId);
              setStatus("streaming");
              attachStream(outcome.activeTurnId, 0);
              return;
            }
            setError("A turn is already running for this workspace.");
            setStatus("error");
            updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
            return;
          }
          setTurnId(outcome.turnId);
          setStatus("streaming");
          attachStream(outcome.turnId, 0);
        } catch (err) {
          if (superseded()) return;
          if (isUpstreamGone(err)) {
            invalidateLaunched(err instanceof Error ? err.message : String(err));
          }
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
          updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
        }
      })();
    },
    [locked, agentSessionKey, client, ensureAgent, attachStream, invalidateLaunched, updateAssistant],
  );

  // Stop: cancel any in-flight send pipeline, close the stream, abort the turn
  // on the agent (so the server-side model loop actually ends and the workspace
  // stops changing), then run the normal end-of-turn convergence.
  const stop = useCallback(() => {
    sendGenRef.current++;
    streamRef.current?.close();
    streamRef.current = null;
    const assistantId = assistantIdRef.current;
    if (assistantId) updateAssistant(assistantId, (m) => ({ ...m, pending: false }));
    const convId = conversationIdRef.current;
    const activeTurn = turnIdRef.current;
    void (async () => {
      if (convId && activeTurn && agentUrlRef.current) {
        try {
          const outcome = await client().abortTurn(convId, activeTurn);
          if (!outcome.supported) {
            console.warn(
              "This agent predates the abort endpoint — the stopped turn keeps running server-side until it finishes.",
            );
          }
        } catch (err) {
          setError(
            `Failed to abort the running turn: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await endTurn();
    })();
  }, [client, endTurn, updateAssistant]);

  // ── conversation switch (workspace load / reload) ────────────────────────────
  // Load the persisted thread for an effective conversationId and re-attach to
  // any in-flight turn. Shared by workspace-open and start-over.
  const openConversation = useCallback(
    (effectiveId: string) => {
      streamRef.current?.close();
      streamRef.current = null;
      setConversationId(effectiveId);
      setError(null);
      const chat = loadChat(effectiveId);
      lastEventIdRef.current = chat.lastEventId;
      setHistory(chat.history ?? []);
      // Re-attach only against the SAME agent session the turn was started on
      // (a workspace switch back, or the dev override across reloads). Anything
      // else is stale — a fresh page load has no container, and a re-launched
      // container has no journal for the turn (its stream would tail forever) —
      // so mark the pending bubble interrupted instead.
      if (overrideRef.current) agentUrlRef.current = overrideRef.current;
      const reachable =
        Boolean(agentUrlRef.current) &&
        chat.agentSession != null &&
        chat.agentSession === agentSessionKey();
      if (chat.activeTurnId && reachable) {
        // Re-attach to an in-flight turn: continue the last pending assistant.
        const pending = [...chat.messages].reverse().find((m) => m.role === "assistant" && m.pending);
        assistantIdRef.current = pending?.id ?? null;
        setMessages(chat.messages);
        setTurnId(chat.activeTurnId);
        setStatus("streaming");
        attachStream(chat.activeTurnId, chat.lastEventId);
        return;
      }
      if (chat.activeTurnId) {
        const pendingId = [...chat.messages].reverse().find((m) => m.role === "assistant" && m.pending)?.id;
        setMessages(
          chat.messages.map((m) =>
            m.id === pendingId
              ? { ...m, pending: false, error: "Interrupted — the agent session ended before this turn completed." }
              : m,
          ),
        );
      } else {
        setMessages(chat.messages);
      }
      assistantIdRef.current = null;
      setTurnId(null);
      setStatus("idle");
    },
    [agentSessionKey, attachStream],
  );

  const setConversation = useCallback(
    (key: string | null) => {
      workspaceKeyRef.current = key;
      if (!key) {
        streamRef.current?.close();
        streamRef.current = null;
        setConversationId(null);
        setMessages([]);
        setHistory([]);
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
    // Drop the current thread's persisted transcript, then mint a fresh UUID —
    // a new conversation the agent has no history for.
    const current = loadConversationId(key);
    if (current) clearChat(current);
    const next = crypto.randomUUID();
    saveConversationId(key, next);
    lastEventIdRef.current = 0;
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
    conversationId,
    messages,
    status,
    locked,
    error,
    send,
    stop,
    clearConversation,
    setConversation,
    registerWorkspace,
    setRunner,
    setRunnerAcceptedTerms,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
