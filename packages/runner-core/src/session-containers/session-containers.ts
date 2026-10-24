import { createHash, timingSafeEqual } from "node:crypto";

import type { SessionRegistry } from "../session/registry.js";
import { generateWorkloadToken } from "../session/workload-token.js";
import type {
  SessionStore,
  StoredContainerEngine,
  StoredSessionContainer,
} from "../session-store/session-store.js";
import type { AdmittedCreate } from "./create-request.js";
import type { SessionContainerEngine } from "./session-container-engine.js";

/** The variables a session's workload reads its container engine from. */
export const ENGINE_URL_ENV = "TELO_HOST_CONTAINER_ENGINE_URL";
export const ENGINE_TOKEN_ENV = "TELO_HOST_CONTAINER_ENGINE_TOKEN";

/** A container a session started, as core records it. */
export type SessionContainer = StoredSessionContainer;

interface SessionState {
  /** The token every new run gets. */
  token: string;
  /** SHA-256 of every token a live run may hold: the current one, plus those
   *  minted by earlier runner processes for runs that outlived them. */
  accepted: Set<string>;
  containers: Map<string, SessionContainer>;
  /** Creates in flight, counted against the ceiling. */
  creating: number;
  /** Bumped by every release, so a create that lands after one is undone. */
  epoch: number;
  /** The session ended: nothing more is created and the state is dropped. */
  closed: boolean;
}

export type Authorization = "ok" | "unknown_session" | "missing_token" | "wrong_token";

export type CreateOutcome =
  | { kind: "created"; id: string }
  | { kind: "ceiling"; max: number }
  | { kind: "ended" };

export interface SessionContainersDeps {
  engine: SessionContainerEngine;
  registry: SessionRegistry;
  /** Where each session's containers and accepted token hashes are kept, so a
   *  run that outlives the runner process keeps its engine. */
  store: SessionStore;
  max: number;
  internalUrl: string;
  log: { warn(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
}

/**
 * The containers each session started through its engine endpoint: the token
 * that admits the session, the ceiling, the scoping of every id, and removal.
 *
 * A session's containers are removed whenever the runs that started them are
 * gone — a suspend, a failure, a deletion, a change to its app set or agent —
 * because nothing else would: the workload that started them removes them only
 * when it ends normally. The runner shutting down removes nothing: a workload
 * may outlive it, and its runs keep their containers. So each session's
 * containers and the SHA-256 of every token a live run may hold are written to
 * the store; a restart mints a new token for new runs, keeps admitting the old
 * ones for a session it adopts, and removes the containers of one it does not
 * (it is suspended, which releases them).
 */
export class SessionContainers {
  private readonly sessions = new Map<string, SessionState>();
  private readonly inFlight = new Set<AbortController>();
  /** Per-session queue of store writes, so the last one written is the newest. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionContainersDeps) {}

  get engine(): SessionContainerEngine {
    return this.deps.engine;
  }

  /**
   * Start serving a session an engine. Its containers are released on every
   * status that means its runs are gone, and the engine ends with the session.
   * `restored` is what an earlier runner process stored for a session whose
   * workload may still run: its containers stay the session's and the tokens
   * its runs hold stay accepted.
   */
  open(sessionId: string, restored: StoredContainerEngine | null): void {
    this.forgetEvicted();
    const token = generateWorkloadToken();
    const state: SessionState = {
      token,
      accepted: new Set([...(restored?.tokenHashes ?? []), tokenHash(token)]),
      containers: new Map((restored?.containers ?? []).map((c) => [c.id, c])),
      creating: 0,
      epoch: 0,
      closed: false,
    };
    this.sessions.set(sessionId, state);
    void this.persistLogged(sessionId, state);
    this.deps.registry.subscribe(sessionId, ({ event }) => {
      if (event.type !== "status") return;
      if (event.status.kind === "stopped") void this.release(sessionId, { close: true });
      else if (event.status.kind === "suspended" || event.status.kind === "failed") {
        void this.release(sessionId, { close: false });
      }
    });
  }

  /** The env a run of the session reads its engine from; a client-supplied
   *  value of either name is written over by it. */
  envOf(sessionId: string): Record<string, string> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) return {};
    return {
      [ENGINE_URL_ENV]: `${this.deps.internalUrl}/v1/sessions/${sessionId}/engine`,
      [ENGINE_TOKEN_ENV]: state.token,
    };
  }

  authorize(sessionId: string, header: string | undefined): Authorization {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) return "unknown_session";
    const match = /^Bearer (.+)$/.exec(header ?? "");
    if (!match) return "missing_token";
    const given = Buffer.from(tokenHash(match[1]!), "hex");
    let ok = false;
    for (const hash of state.accepted) {
      if (timingSafeEqual(given, Buffer.from(hash, "hex"))) ok = true;
    }
    return ok ? "ok" : "wrong_token";
  }

  list(sessionId: string): SessionContainer[] {
    return [...(this.sessions.get(sessionId)?.containers.values() ?? [])];
  }

  get(sessionId: string, id: string): SessionContainer | undefined {
    return this.sessions.get(sessionId)?.containers.get(id);
  }

  async create(sessionId: string, admitted: AdmittedCreate): Promise<CreateOutcome> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) return { kind: "ended" };
    if (state.containers.size + state.creating >= this.deps.max) {
      return { kind: "ceiling", max: this.deps.max };
    }
    const epoch = state.epoch;
    state.creating += 1;
    let id: string;
    try {
      id = await this.deps.engine.create(sessionId, admitted.spec);
    } finally {
      state.creating -= 1;
    }
    if (state.closed || state.epoch !== epoch) {
      await this.deps.engine.remove(sessionId, id);
      return { kind: "ended" };
    }
    state.containers.set(id, {
      id,
      image: admitted.spec.image,
      labels: admitted.spec.labels,
      ports: admitted.spec.ports,
      bound: admitted.bound,
    });
    try {
      await this.persist(sessionId, state);
    } catch (err) {
      // A container the store does not hold would be lost to a restart, so it
      // is not handed out.
      state.containers.delete(id);
      await this.deps.engine.remove(sessionId, id);
      void this.persistLogged(sessionId, state);
      throw new Error(`the container was removed again: recording it in the session store failed: ${messageOf(err)}`, {
        cause: err,
      });
    }
    return { kind: "created", id };
  }

  async remove(sessionId: string, id: string): Promise<void> {
    await this.deps.engine.remove(sessionId, id);
    const state = this.sessions.get(sessionId);
    if (!state?.containers.delete(id)) return;
    await this.persist(sessionId, state);
  }

  /** Forget a container the substrate no longer has. */
  forget(sessionId: string, id: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.containers.delete(id)) void this.persistLogged(sessionId, state);
  }

  /** An abort signal for a request that may outlive the runner's shutdown. */
  track(): { signal: AbortSignal; done(): void } {
    const controller = new AbortController();
    this.inFlight.add(controller);
    return { signal: controller.signal, done: () => this.inFlight.delete(controller) };
  }

  /**
   * Remove every container of one session. `close` ends the session's engine
   * too (its workload is gone for good) and the backend's own session state;
   * without it the token survives, for a suspended session's resume, and no
   * token of an earlier runner process is admitted any more — the runs holding
   * one are gone.
   */
  async release(sessionId: string, options: { close: boolean }): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.epoch += 1;
    if (options.close) {
      state.closed = true;
      this.sessions.delete(sessionId);
    }
    const ids = [...state.containers.keys()];
    state.containers.clear();
    if (!options.close) {
      state.accepted = new Set([tokenHash(state.token)]);
      void this.persistLogged(sessionId, state);
    }
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.deps.engine.remove(sessionId, id);
        } catch (err) {
          this.deps.log.warn(
            { err, sessionId, container: id },
            "failed to remove a container the session started",
          );
        }
      }),
    );
    if (options.close && this.deps.engine.endSession) {
      try {
        await this.deps.engine.endSession(sessionId);
      } catch (err) {
        this.deps.log.warn({ err, sessionId }, "failed to release what the session held beside its containers");
      }
    }
  }

  /** Shutdown: end every in-flight request and finish writing the store. Every
   *  container stays: the runs that started them may outlive the runner, and a
   *  session that does not is suspended at the next boot, which removes them. */
  async shutdown(): Promise<void> {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    await Promise.all([...this.writes.values()]);
  }

  /** Write the session's containers and accepted token hashes to the store,
   *  after every earlier write of the session. */
  private persist(sessionId: string, state: SessionState): Promise<void> {
    const write = (this.writes.get(sessionId) ?? Promise.resolve()).then(async () => {
      if (state.closed) return;
      await this.deps.store.update(sessionId, {
        containerEngine: {
          tokenHashes: [...state.accepted],
          containers: [...state.containers.values()],
        },
      });
    });
    const tail = write.catch(() => undefined);
    this.writes.set(sessionId, tail);
    void tail.then(() => {
      if (this.writes.get(sessionId) === tail) this.writes.delete(sessionId);
    });
    return write;
  }

  /** A write no request waits on: its failure is logged, and the next write of
   *  the session carries the whole state again. */
  private persistLogged(sessionId: string, state: SessionState): Promise<void> {
    return this.persist(sessionId, state).catch((err) =>
      this.deps.log.error(
        { err, sessionId },
        "writing a session's containers to the session store failed — a runner restart would lose them",
      ),
    );
  }

  /** A session the registry no longer holds is dropped. */
  private forgetEvicted(): void {
    for (const sessionId of this.sessions.keys()) {
      if (!this.deps.registry.has(sessionId)) this.sessions.delete(sessionId);
    }
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
