import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { applyEvent, emptyTurn, partName, type LiveTurn, type SentFile } from "./chat-blocks.js";
import { joinPages, needsMore, prepend, type BranchView } from "./chat-branch.js";
import { ChatApi, ChatFailure, type ChatEvent, type ConversationSummary, type Entry, type TurnEndReason } from "./chat-protocol.js";

const TURN_NOT_FOUND = "ERR_CONVERSATION_TURN_NOT_FOUND";
const EMPTY: BranchView = { entries: [], earlier: null };

/** Reconnections tried, without a frame between them, before the viewer is asked. */
const MAX_ATTEMPTS = 5;
/** The wait before reconnection `attempt`, in milliseconds. */
export const reconnectDelay = (attempt: number): number => Math.min(250 * 2 ** (attempt - 1), 4000);

export type Phase = "idle" | "running" | "reconnecting" | "dropped";

type Action =
  | { type: "reset"; turn?: LiveTurn }
  | { type: "event"; event: ChatEvent }
  | { type: "decide"; id: string; approved: boolean; reason?: string }
  | { type: "sent" };

function turnReducer(turn: LiveTurn | undefined, action: Action): LiveTurn | undefined {
  switch (action.type) {
    case "reset":
      return action.turn;
    case "event":
      return turn && applyEvent(turn, action.event);
    case "decide":
      return (
        turn && {
          ...turn,
          blocks: turn.blocks.map((block) =>
            block.kind === "approval" && block.id === action.id
              ? { ...block, decision: { approved: action.approved, ...(action.reason ? { reason: action.reason } : {}) } }
              : block,
          ),
        }
      );
    case "sent":
      return turn && { ...turn, end: undefined, blocks: turn.blocks.map((block) => (block.kind === "approval" ? { ...block, sent: true } : block)) };
  }
}

/** A turn being followed; `done` once it ended or the follow gave up, so nothing is left to watch. */
interface PendingTurn {
  conversation: string;
  turn: string;
  done: boolean;
}

/** What a message to send holds. */
export interface Outgoing {
  message: string;
  attachments: string[];
  /** Shown while the turn runs: what was attached. */
  files?: SentFile[];
  /** Absent: the latest branch continues. Null: a new root. */
  parent?: string | null;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const newKey = () => (typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** What the page learns of the session: a send admitted, a conversation given its id, a turn ended. */
export interface SessionHooks {
  /** A send was admitted (2xx), in a new or an existing conversation, whichever conversation is shown by now. */
  admitted: (conversation: string) => void;
  /** A new conversation was given its id by the first admitted send. */
  assigned: (previous: string | undefined, id: string) => void;
  /** A turn this session started or followed ended, whatever its reason and whichever conversation is shown by now. */
  ended: (conversation: string) => void;
}

/**
 * One conversation as it is shown: the branch being read, the turn being
 * written and how it is following. Opening one reads its summary and its latest
 * branch, and tails its turn from the start when that is still running. Sending
 * starts a turn, whose events are read until it ends — reconnecting with the last
 * position when the stream drops — and the branch is read again once it has.
 * Every continuation belongs to the conversation that started it: once another is
 * opened, what it was waiting for is dropped on arrival, and its turn runs on.
 */
export function useChatSession(api: ChatApi, hooks: SessionHooks) {
  const [conversation, setConversation] = useState<string>();
  const [view, setView] = useState<BranchView>(EMPTY);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** Whether the last earlier page failed to be read, so it is read again only when asked. */
  const [earlierFailed, setEarlierFailed] = useState(false);
  const readingEarlier = useRef(false);
  const [loading, setLoading] = useState(false);
  const [live, dispatch] = useReducer(turnReducer, undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<ChatFailure>();
  /** Whether opening the conversation failed, so there is nothing to continue. */
  const [unavailable, setUnavailable] = useState(false);
  const [ended, setEnded] = useState<TurnEndReason>();
  /** The open conversation's record; null for a new one, and until it is read. */
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const viewRef = useRef(view);
  viewRef.current = view;
  /** Decisions given to a reloaded entry's pending approvals, not yet sent. */
  const given = useRef(new Map<string, { id: string; approved: boolean; reason?: string }>());
  /**
   * `generation` is the ownership token of the opened conversation, aborted when another is opened; `abort` is
   * the token of the turn being followed. A continuation that finds its token aborted writes nothing.
   */
  const current = useRef({ conversation, turn: undefined as string | undefined, pending: undefined as PendingTurn | undefined, generation: new AbortController(), abort: new AbortController() });
  /** Turns of conversations switched away from that are read to their end, so the page hears of it. */
  const watches = useRef(new Map<string, AbortController>());
  current.current.conversation = conversation;
  const retry = useRef<(() => void) | undefined>(undefined);
  const page = useRef(hooks);
  page.current = hooks;

  const entries = view.entries;

  /** The branch through `through` (else the latest), read newest first until it joins what is drawn. */
  const readBranch = useCallback(
    async (id: string, signal: AbortSignal, through?: string): Promise<BranchView> => {
      const drawn = viewRef.current;
      const pages = [await api.entriesPage(id, { through }, signal)];
      while (!signal.aborted && needsMore(drawn.entries, pages)) pages.push(await api.entriesPage(id, { cursor: pages[pages.length - 1].next }, signal));
      return joinPages(drawn, pages);
    },
    [api],
  );

  const load = useCallback(
    async (id: string, through?: string, signal = current.current.generation.signal): Promise<boolean> => {
      setLoading(true);
      try {
        const branch = await readBranch(id, signal, through);
        if (signal.aborted) return false;
        setView(branch);
        return true;
      } catch (error) {
        if (signal.aborted) return false;
        if (!(error instanceof ChatFailure)) throw error;
        setFailure(error);
        retry.current = () => (setFailure(undefined), void load(id, through));
        return false;
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [readBranch],
  );

  /** Reads the open conversation's record again, for as long as it is the one shown. */
  const readSummary = useCallback(
    async (id: string, signal: AbortSignal) => {
      try {
        const read = await api.conversation(id, signal);
        if (!signal.aborted && current.current.conversation === id) setSummary(read);
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof ChatFailure)) throw error;
        setFailure(error);
      }
    },
    [api],
  );

  const loadEarlier = useCallback(async () => {
    const { earlier } = viewRef.current;
    const id = current.current.conversation;
    if (!earlier || !id || readingEarlier.current) return;
    const { signal } = current.current.generation;
    readingEarlier.current = true;
    setEarlierFailed(false);
    setLoadingEarlier(true);
    try {
      const page = await api.entriesPage(id, { cursor: earlier }, signal);
      if (signal.aborted) return;
      setView((now) => prepend(now, page));
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof ChatFailure)) throw error;
      setFailure(error);
      setEarlierFailed(true);
      retry.current = () => (setFailure(undefined), void loadEarlier());
    } finally {
      if (!signal.aborted) {
        readingEarlier.current = false;
        setLoadingEarlier(false);
      }
    }
  }, [api]);

  const finish = useCallback(
    async (id: string, reason: TurnEndReason, signal: AbortSignal) => {
      setEnded(reason);
      if (reason === "approval") {
        setPhase("idle");
        return page.current.ended(id);
      }
      const error = liveRef.current?.error;
      void readSummary(id, signal);
      const loaded = await load(id, undefined, signal);
      // The turn has ended whichever conversation is shown.
      if (signal.aborted) return page.current.ended(id);
      if (loaded) dispatch({ type: "reset" });
      given.current.clear();
      if (error) setFailure(new ChatFailure(error.code, error.detail));
      setPhase("idle");
      page.current.ended(id);
    },
    [load, readSummary],
  );

  /** A tool result of a call that an entry already holds, which a resumed turn answers; false when the live turn is the one drawing the call. */
  const settleStored = useCallback((event: ChatEvent): boolean => {
    const result = event as { id: string; result: unknown; isError?: boolean };
    if (liveRef.current?.blocks.some((block) => block.kind === "tool" && block.id === result.id)) return false;
    const holds = (entry: Entry) => entry.toolCalls?.some((call) => call.id === result.id) === true;
    if (!viewRef.current.entries.some(holds)) return false;
    const answer = { id: result.id, result: result.result, ...(result.isError !== undefined ? { isError: result.isError } : {}) };
    setView((now) => ({
      ...now,
      entries: now.entries.map((entry) => (holds(entry) ? { ...entry, toolResults: [...(entry.toolResults ?? []).filter((each) => each.id !== result.id), answer] } : entry)),
    }));
    return true;
  }, []);

  const run = useCallback(
    async (id: string, turn: string, signal: AbortSignal, pending: PendingTurn, from?: string) => {
      let lastId = from;
      let attempts = 0;
      let reason: TurnEndReason | undefined;
      while (!signal.aborted && reason === undefined) {
        let progressed = false;
        try {
          setPhase("running");
          await api.events(turn, lastId, signal, (frame, event) => {
            if (signal.aborted) return;
            progressed = true;
            if (frame !== undefined) lastId = frame;
            if (!(event.type === "tool-result" && settleStored(event))) dispatch({ type: "event", event });
            if (event.type === "turn-end") ((reason = (event as { reason: TurnEndReason }).reason), (pending.done = true));
          });
        } catch (error) {
          if (signal.aborted) return;
          if (!(error instanceof ChatFailure) || !error.transient) {
            if (!(error instanceof ChatFailure)) throw error;
            if (error.code === TURN_NOT_FOUND) {
              // The turn's events are gone: what it appended is read instead.
              const loaded = await load(id, undefined, signal);
              if (signal.aborted) return;
              if (loaded) dispatch({ type: "reset" });
              return setPhase("idle");
            }
            setFailure(error);
            return setPhase("idle");
          }
        }
        if (reason !== undefined || signal.aborted) break;
        attempts = progressed ? 1 : attempts + 1;
        if (attempts > MAX_ATTEMPTS) {
          retry.current = () => void follow(id, turn, current.current.abort.signal, lastId);
          return setPhase("dropped");
        }
        setPhase("reconnecting");
        await delay(reconnectDelay(attempts), signal);
      }
      if (!signal.aborted && reason !== undefined) await finish(id, reason, signal);
    },
    [api, finish, load, settleStored],
  );

  const follow = useCallback(
    async (id: string, turn: string, signal: AbortSignal, from?: string) => {
      if (signal.aborted) return;
      // Following takes over from a watch of the same turn.
      watches.current.get(turn)?.abort();
      watches.current.delete(turn);
      const pending: PendingTurn = { conversation: id, turn, done: false };
      current.current.turn = turn;
      current.current.pending = pending;
      try {
        await run(id, turn, signal, pending, from);
      } finally {
        if (!signal.aborted) pending.done = true;
      }
    },
    [run],
  );

  /** Reads a turn's events to its end without drawing them, then tells the page it ended. */
  const watch = useCallback(
    async (id: string, turn: string) => {
      if (watches.current.has(turn)) return;
      const controller = new AbortController();
      const { signal } = controller;
      watches.current.set(turn, controller);
      let lastId: string | undefined;
      let attempts = 0;
      let reached = false;
      while (!signal.aborted && !reached) {
        let progressed = false;
        try {
          await api.events(turn, lastId, signal, (frame, event) => {
            progressed = true;
            if (frame !== undefined) lastId = frame;
            if (event.type === "turn-end") reached = true;
          });
        } catch (error) {
          if (signal.aborted) return;
          if (!(error instanceof ChatFailure)) throw error;
          // A turn whose events are gone, or a failure that will not pass, is as good as ended for those waiting on it.
          if (!error.transient) break;
        }
        if (reached || signal.aborted) break;
        attempts = progressed ? 1 : attempts + 1;
        if (attempts > MAX_ATTEMPTS) break;
        await delay(reconnectDelay(attempts), signal);
      }
      if (signal.aborted) return;
      watches.current.delete(turn);
      page.current.ended(id);
    },
    [api],
  );

  const send = useCallback(
    async (outgoing: Outgoing, approvals?: { id: string; approved: boolean; reason?: string }[]) => {
      const key = newKey();
      const resumed = approvals !== undefined;
      const attempt = async (): Promise<void> => {
        current.current.abort.abort();
        const abort = new AbortController();
        current.current.abort = abort;
        setFailure(undefined);
        setEnded(undefined);
        setPhase("running");
        if (resumed) dispatch(liveRef.current ? { type: "sent" } : { type: "reset", turn: emptyTurn() });
        else dispatch({ type: "reset", turn: emptyTurn({ text: outgoing.message, files: outgoing.files ?? [] }) });
        try {
          const started = await api.startTurn(
            {
              ...(current.current.conversation ? { conversation: current.current.conversation } : {}),
              ...(outgoing.parent !== undefined ? { parent: outgoing.parent } : {}),
              message: outgoing.message,
              attachments: outgoing.attachments,
              ...(resumed ? { approvals } : {}),
            },
            key,
          );
          // Another conversation was opened meanwhile: the turn runs on, and is tailed when its conversation is opened again.
          if (abort.signal.aborted) {
            void watch(started.conversation, started.turn);
            return page.current.admitted(started.conversation);
          }
          const previous = current.current.conversation;
          const fresh = previous !== started.conversation;
          current.current.conversation = started.conversation;
          setConversation(started.conversation);
          if (fresh) page.current.assigned(previous, started.conversation);
          page.current.admitted(started.conversation);
          void readSummary(started.conversation, current.current.generation.signal);
          await follow(started.conversation, started.turn, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) return;
          if (!(error instanceof ChatFailure)) throw error;
          if (!resumed) dispatch({ type: "reset" });
          setFailure(error);
          setPhase("idle");
          retry.current = () => void attempt();
        }
      };
      await attempt();
    },
    [api, follow, watch, readSummary],
  );

  /**
   * Show another conversation, or an empty one. A conversation is read from its
   * summary and its latest branch; when its turn is still open, that turn's entries
   * are set aside and its events are read from the start as the live turn.
   */
  const open = useCallback(
    (id?: string) => {
      const pending = current.current.pending;
      current.current.generation.abort();
      current.current.abort.abort();
      if (pending && !pending.done) void watch(pending.conversation, pending.turn);
      const generation = new AbortController();
      const abort = new AbortController();
      current.current = { conversation: id, turn: undefined, pending: undefined, generation, abort };
      viewRef.current = EMPTY;
      given.current.clear();
      retry.current = undefined;
      setLoading(false);
      readingEarlier.current = false;
      setLoadingEarlier(false);
      setEarlierFailed(false);
      setConversation(id);
      setView(EMPTY);
      setFailure(undefined);
      setUnavailable(false);
      setEnded(undefined);
      setSummary(null);
      setPhase("idle");
      dispatch({ type: "reset" });
      if (!id) return;
      const reopen = async (): Promise<void> => {
        setLoading(true);
        try {
          const summary = await api.conversation(id, generation.signal);
          const branch = await readBranch(id, generation.signal);
          if (generation.signal.aborted) return;
          setSummary(summary);
          if (!summary.running || summary.turn === null) return setView(branch);
          const mine = branch.entries.filter((entry) => entry.turn === summary.turn);
          const user = mine.find((entry) => entry.role === "user");
          const text = user?.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n\n") ?? "";
          const files: SentFile[] =
            user?.parts
              .filter((part) => ["image", "audio", "video", "file"].includes(part.type))
              .map((part) => ({ name: partName(part as { url: string }), image: part.type === "image", url: (part as { url: string }).url })) ?? [];
          setView({ ...branch, entries: branch.entries.filter((entry) => entry.turn !== summary.turn) });
          dispatch({ type: "reset", turn: emptyTurn(user && (text !== "" || files.length > 0) ? { text, files } : undefined) });
          setLoading(false);
          await follow(id, summary.turn, abort.signal);
        } catch (error) {
          if (generation.signal.aborted) return;
          if (!(error instanceof ChatFailure)) throw error;
          setFailure(error);
          setUnavailable(true);
          retry.current = () => (setFailure(undefined), open(id));
        } finally {
          if (!generation.signal.aborted) setLoading(false);
        }
      };
      void reopen();
    },
    [api, readBranch, follow, watch],
  );

  /**
   * Read the shown conversation again where it is drawn: the view, its scroll position and
   * its end note stay until the new data arrives. A conversation whose turn runs elsewhere is opened.
   */
  const refresh = useCallback(async () => {
    const id = current.current.conversation;
    if (!id) return;
    const { signal } = current.current.generation;
    try {
      const summary = await api.conversation(id, signal);
      const branch = await readBranch(id, signal);
      if (signal.aborted) return;
      if (summary.running) return open(id);
      setSummary(summary);
      setView(branch);
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof ChatFailure)) throw error;
      setFailure(error);
      setUnavailable(true);
      retry.current = () => (setFailure(undefined), open(id));
    }
  }, [api, readBranch, open]);

  /** Show the branch through a sibling of an entry. */
  const switchTo = useCallback(
    (sibling: string) => {
      const id = current.current.conversation;
      if (id) void load(id, sibling);
    },
    [load],
  );

  const stop = useCallback(async () => {
    const { turn, generation } = current.current;
    if (!turn) return;
    try {
      await api.cancelTurn(turn);
    } catch (error) {
      if (!(error instanceof ChatFailure)) throw error;
      if (!generation.signal.aborted) setFailure(error);
    }
  }, [api]);

  /** A decision on an approval of a stored entry: sent, with every other of the entry's, once none is pending. */
  const decideStored = useCallback(
    (id: string, approved: boolean, reason?: string) => {
      const holds = (entry: Entry) => entry.toolCalls?.some((call) => call.approval?.id === id) === true;
      const entry = viewRef.current.entries.find(holds);
      if (!entry) return;
      const decision = { approved, ...(reason ? { reason } : {}) };
      given.current.set(id, { id, ...decision });
      const calls = (entry.toolCalls ?? []).map((call) => (call.approval?.id === id ? { ...call, approval: { id, decision } } : call));
      setView((now) => ({ ...now, entries: now.entries.map((each) => (each.id === entry.id ? { ...each, toolCalls: calls } : each)) }));
      const pending = calls.filter((call) => call.approval && call.approval.decision === null);
      if (pending.length > 0) return;
      const decided = calls.flatMap((call) => (call.approval && given.current.has(call.approval.id) ? [given.current.get(call.approval.id) as { id: string; approved: boolean; reason?: string }] : []));
      given.current.clear();
      void send({ message: "", attachments: [], parent: entry.id }, decided);
    },
    [send],
  );

  const decide = useCallback(
    (id: string, approved: boolean, reason?: string) => {
      const turn = liveRef.current;
      if (!turn?.blocks.some((block) => block.kind === "approval" && block.id === id)) return decideStored(id, approved, reason);
      dispatch({ type: "decide", id, approved, reason });
      const open = turn.blocks.filter((block) => block.kind === "approval" && !block.sent);
      const decided = open.map((block) => {
        const approval = block as Extract<(typeof open)[number], { kind: "approval" }>;
        return approval.id === id ? { id, approved, ...(reason ? { reason } : {}) } : approval.decision ? { id: approval.id, ...approval.decision } : undefined;
      });
      if (decided.every((each) => each !== undefined)) void send({ message: "", attachments: [], }, decided as { id: string; approved: boolean; reason?: string }[]);
    },
    [send, decideStored],
  );

  useEffect(() => {
    // A development remount runs the cleanup once before the page is used.
    if (current.current.generation.signal.aborted) current.current = { ...current.current, generation: new AbortController(), abort: new AbortController() };
    return () => {
      current.current.generation.abort();
      current.current.abort.abort();
      for (const controller of watches.current.values()) controller.abort();
      watches.current.clear();
    };
  }, []);

  return {
    conversation,
    summary,
    /** The conversation shown right now, ahead of the next render. */
    shown: () => current.current.conversation,
    unavailable,
    entries,
    earlier: view.earlier !== null,
    loadingEarlier,
    earlierFailed,
    loadEarlier,
    loading,
    live,
    phase,
    failure,
    ended,
    send: (outgoing: Outgoing) => send(outgoing),
    open,
    refresh,
    switchTo,
    stop,
    decide,
    /** Try again what failed last. */
    retry: () => {
      setFailure(undefined);
      retry.current?.();
    },
    dismiss: () => setFailure(undefined),
  };
}
