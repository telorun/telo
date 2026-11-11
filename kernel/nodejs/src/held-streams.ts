import {
  celMapFromEntries,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  isCelMap,
  isCelRecord,
  Stream,
  type InvokeContext,
} from "@telorun/sdk";

/**
 * Held streams and their owners (`kernel/specs/invocation-contract.md`, "Held
 * streams"). A stream leaving a scope run is wrapped so the runtime sees it
 * settle; the run is torn down only once every stream leaving it has. Each held
 * stream is OWNED by the dispatch that received it, and a dispatch whose
 * ownership closes cancels what it still owns. A stream with no scope behind it
 * is never wrapped.
 */

/** What a held stream's settlement is reported to: a dispatch, a scope run, a root. */
export class StreamOwner {
  /** Held streams registered here, cancelled when this owner closes. */
  private owned: Set<HeldStream> | undefined;
  /** Unsettled held streams that left this owner, and detached work issued while
   *  it held one; it stays open while any is live. */
  private leaving: Set<object> | undefined;
  /** Scope runs the dispatch this owner belongs to opened and has not torn down. */
  openRuns: Set<StreamOwner> | undefined;
  private produced = false;
  private closedWith: string | undefined;
  private listeners: Array<() => void> | undefined;

  /** A detached task's hold on what its issuer held, until its inputs are walked. */
  private provisional: { token: object; holders: StreamOwner[] } | undefined;

  constructor(
    /** The owner of the dispatch that issued this one, else none. */
    readonly parent: StreamOwner | undefined,
    /** Why a stream still owned here is cancelled when it closes. */
    private readonly ending: string,
    /** For a detached task's owner: the dispatch that started the task. */
    readonly taskIssuer?: StreamOwner,
    /** For a scope run: the resource holding the scope, as a message names it. */
    readonly label?: string,
  ) {}

  /** Keep `holders` open until {@link releaseProvisional}. */
  holdProvisionally(holders: StreamOwner[]): void {
    if (holders.length === 0) return;
    const token = {};
    for (const holder of holders) holder.addLeaving(token);
    this.provisional = { token, holders };
  }

  releaseProvisional(): void {
    const provisional = this.provisional;
    if (!provisional) return;
    this.provisional = undefined;
    for (const holder of provisional.holders) holder.releaseLeaving(provisional.token);
  }

  get closed(): boolean {
    return this.closedWith !== undefined;
  }

  /** Why this owner closed, once it has. */
  get closedReason(): string | undefined {
    return this.closedWith;
  }

  /** True while a held stream registered here has not settled. */
  ownsLive(): boolean {
    return (this.owned?.size ?? 0) > 0;
  }

  /** The owner has produced its value: it closes once nothing leaving it is live. */
  produce(): void {
    this.produced = true;
    this.closeIfDone();
  }

  /** Close now, whatever is still leaving — a root disposed or cancelled. */
  close(ending: string = this.ending): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = ending;
    const owned = this.owned;
    this.owned = undefined;
    if (owned) for (const held of owned) held.cancel(ending);
    const listeners = this.listeners;
    this.listeners = undefined;
    if (listeners) for (const listener of listeners) listener();
  }

  /** Called once, when the owner closes (at once when it already has). */
  onClose(listener: () => void): void {
    if (this.closedWith !== undefined) listener();
    else (this.listeners ??= []).push(listener);
  }

  addLeaving(key: object): void {
    (this.leaving ??= new Set()).add(key);
  }

  releaseLeaving(key: object): void {
    if (this.leaving?.delete(key)) this.closeIfDone();
  }

  /** The held streams still leaving this owner. */
  leavingStreams(): HeldStream[] {
    return [...(this.leaving ?? [])].filter((key): key is HeldStream => key instanceof HeldStream);
  }

  /** @internal */
  adopt(held: HeldStream): void {
    (this.owned ??= new Set()).add(held);
  }

  /** @internal */
  disown(held: HeldStream): void {
    this.owned?.delete(held);
  }

  private closeIfDone(): void {
    if (this.produced && (this.leaving?.size ?? 0) === 0) this.close();
  }
}

/** The owner a context carries, when it carries one the kernel minted. */
export function streamOwnerOf(ctx: InvokeContext | undefined): StreamOwner | undefined {
  const owner = ctx?.owner;
  return owner instanceof StreamOwner ? owner : undefined;
}

export const DISPATCH_ENDED = "the dispatch that received it ended without reading it or passing it on";
export const INBOUND_COMPLETED = "the inbound work that received it completed without reading it";
export const INBOUND_ABANDONED = "the inbound work that received it was abandoned";
export const BOOT_RUN_ENDED = "the application's boot run ended without reading it";
export const DETACHED_TASK_ENDED = "the detached work that received it ended without reading it";
export const RUNTIME_STOPPING = "the runtime is shutting down";
export const NO_OPENED_CONTEXT =
  "it reached a caller that opened no context; dispatch under a source from ctx.createCancellationSource() " +
  "(as ctx.rootContext({ cancellation: source })) and dispose the source once the work completes";

/** A root: a context an inbound source opens, owning until disposed or cancelled. */
export function rootOwner(): StreamOwner {
  return new StreamOwner(undefined, INBOUND_COMPLETED);
}

/** The schema a walk reads to skip what can hold no stream. */
export interface WalkGuide {
  readonly schema: unknown;
  resolveRef(ref: string): Record<string, unknown> | undefined;
}

const closedSchemas = new WeakMap<object, boolean>();

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

/**
 * True when no value the schema admits can hold a stream: every object closed
 * (`additionalProperties: false`), every array's items so, and no stream type
 * anywhere. Anything the reading cannot decide counts as open.
 */
export function holdsNoLiveValue(schema: unknown, guide: WalkGuide, visiting = new Set<object>()): boolean {
  if (schema === false) return true;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const node = schema as Record<string, unknown>;
  const memo = closedSchemas.get(node);
  if (memo !== undefined) return memo;
  if (visiting.has(node)) return false;
  visiting.add(node);
  const answer = decideClosed(node, guide, visiting);
  visiting.delete(node);
  closedSchemas.set(node, answer);
  return answer;
}

function decideClosed(node: Record<string, unknown>, guide: WalkGuide, visiting: Set<object>): boolean {
  if (typeof node.$ref === "string") {
    const target = guide.resolveRef(node.$ref);
    return target !== undefined && holdsNoLiveValue(target, guide, visiting);
  }
  if ("x-telo-stream" in node) return false;
  const typed = node["x-telo-type"];
  if (typed !== undefined) {
    const name = typeof typed === "string" ? typed : (typed as { name?: unknown } | null)?.name;
    return name !== "Telo.Stream";
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      if (!branches.every((branch) => holdsNoLiveValue(branch, guide, visiting))) return false;
      if (node.type === undefined && node.properties === undefined) return true;
    }
  }
  if ("not" in node || "if" in node || "patternProperties" in node || "dependencies" in node) return false;
  if ("const" in node || Array.isArray(node.enum)) return true;
  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  if (types.length > 0 && types.every((type) => SCALAR_TYPES.has(type as string))) return true;
  if (types.includes("object") || node.properties !== undefined) {
    if (node.additionalProperties !== false) return false;
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    if (!Object.values(properties).every((property) => holdsNoLiveValue(property, guide, visiting))) return false;
    return types.every((type) => type === "object" || SCALAR_TYPES.has(type as string));
  }
  if (types.includes("array")) {
    const items = node.items;
    if (Array.isArray(items)) {
      return node.additionalItems === false && items.every((item) => holdsNoLiveValue(item, guide, visiting));
    }
    if (!holdsNoLiveValue(items, guide, visiting)) return false;
    return types.every((type) => type === "array" || SCALAR_TYPES.has(type as string));
  }
  return false;
}

function resolved(schema: unknown, guide: WalkGuide): Record<string, unknown> | undefined {
  let node = schema;
  for (let hops = 0; hops < 32 && node && typeof node === "object"; hops++) {
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref !== "string") return node as Record<string, unknown>;
    node = guide.resolveRef(ref);
  }
  return undefined;
}

function propertySchema(schema: unknown, key: string, guide: WalkGuide): unknown {
  const node = resolved(schema, guide);
  if (!node) return undefined;
  const declared = (node.properties as Record<string, unknown> | undefined)?.[key];
  if (declared !== undefined) return declared;
  return typeof node.additionalProperties === "object" ? node.additionalProperties : undefined;
}

function itemSchema(schema: unknown, guide: WalkGuide): unknown {
  const items = resolved(schema, guide)?.items;
  return items && typeof items === "object" && !Array.isArray(items) ? items : undefined;
}

/** The item type of a stream-typed node, `{ name: Telo.Stream, of }`. */
function streamItemSchema(schema: unknown, guide: WalkGuide): unknown {
  const typed = resolved(schema, guide)?.["x-telo-type"];
  return typed && typeof typed === "object" ? (typed as { of?: unknown }).of : undefined;
}

type StreamVisitor = (stream: Stream<unknown>, held: HeldStream | undefined, itemGuide: WalkGuide | undefined) => unknown;

/**
 * `value` with each stream reachable through maps and lists replaced by what
 * `visit` answers — copied where something changed, the identical value where
 * nothing did. A subtree the guide proves can hold no stream is not entered.
 */
export function replaceStreams(value: unknown, guide: WalkGuide | undefined, visit: StreamVisitor): unknown {
  return walk(value, guide?.schema, guide, visit, new Set());
}

function walk(
  value: unknown,
  schema: unknown,
  guide: WalkGuide | undefined,
  visit: StreamVisitor,
  path: Set<object>,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (guide && schema !== undefined && holdsNoLiveValue(schema, guide)) return value;
  if (value instanceof Stream) {
    const itemGuide = guide && schema !== undefined
      ? { schema: streamItemSchema(schema, guide), resolveRef: guide.resolveRef }
      : undefined;
    return visit(value, heldStreamOf(value), itemGuide?.schema === undefined ? undefined : itemGuide);
  }
  if (path.has(value)) return value;
  if (Array.isArray(value)) {
    path.add(value);
    const items = guide && schema !== undefined ? itemSchema(schema, guide) : undefined;
    let copy: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = walk(value[i], items, guide, visit, path);
      if (next === value[i]) continue;
      copy ??= [...value];
      copy[i] = next;
    }
    path.delete(value);
    return copy ?? value;
  }
  if (isCelMap(value)) {
    path.add(value);
    let changed = false;
    const flat: unknown[] = [];
    for (const { key, value: entry } of value.entries.values()) {
      const next = walk(entry, undefined, guide, visit, path);
      if (next !== entry) changed = true;
      flat.push(key, next);
    }
    path.delete(value);
    return changed ? celMapFromEntries(flat as Parameters<typeof celMapFromEntries>[0]) : value;
  }
  if (!isCelRecord(value)) return value;
  path.add(value);
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const entry = (value as Record<string, unknown>)[key];
    const next = walk(entry, guide && schema !== undefined ? propertySchema(schema, key, guide) : undefined, guide, visit, path);
    if (next === entry) continue;
    copy ??= { ...(value as Record<string, unknown>) };
    copy[key] = next;
  }
  path.delete(value);
  return copy ?? value;
}

const heldByStream = new WeakMap<object, HeldStream>();

/** The held stream a wrapper is, when it is one. */
export function heldStreamOf(stream: unknown): HeldStream | undefined {
  return stream && typeof stream === "object" ? heldByStream.get(stream) : undefined;
}

type Settlement = "finished" | "failed" | "cancelled";

/**
 * A stream the runtime holds: the wrapper consumers read, which forwards each
 * item as it is pulled — never ahead of the consumer, nothing buffered — and
 * reports when the stream settles.
 */
export class HeldStream {
  readonly stream: Stream<unknown>;
  private ownedBy: StreamOwner | undefined;
  private readonly producers = new Set<StreamOwner>();
  private active = 0;
  private settled: Settlement | undefined;
  private cancelledWith: string | undefined;

  constructor(
    private readonly source: AsyncIterable<unknown>,
    /** The resource the stream comes from, as a message names it. */
    readonly origin: string,
    producers: Iterable<StreamOwner>,
    private readonly itemGuide: WalkGuide | undefined,
  ) {
    for (const producer of producers) this.addProducer(producer);
    this.stream = new Stream({ [Symbol.asyncIterator]: () => this.iterate() });
    heldByStream.set(this.stream, this);
  }

  get owner(): StreamOwner | undefined {
    return this.ownedBy;
  }

  get isSettled(): boolean {
    return this.settled !== undefined;
  }

  /** Keep `producer` open until this stream settles. */
  addProducer(producer: StreamOwner): void {
    if (this.settled !== undefined || this.producers.has(producer)) return;
    this.producers.add(producer);
    producer.addLeaving(this);
  }

  /** Register with `owner` — or, with none or a closed one, cancel at once. */
  registerWith(owner: StreamOwner | undefined): void {
    if (this.settled !== undefined) return;
    this.ownedBy?.disown(this);
    this.ownedBy = undefined;
    if (!owner) return this.cancel(NO_OPENED_CONTEXT);
    if (owner.closed) return this.cancel(owner.closedReason ?? DISPATCH_ENDED);
    this.ownedBy = owner;
    owner.adopt(this);
  }

  /** Settle as cancelled; a pull after this raises `ERR_INVOKE_CANCELLED`. */
  cancel(reason: string): void {
    if (this.settled !== undefined) return;
    this.cancelledWith = reason;
    this.settle("cancelled");
  }

  private settle(as: Settlement): void {
    if (this.settled !== undefined) return;
    this.settled = as;
    this.ownedBy?.disown(this);
    this.ownedBy = undefined;
    const producers = [...this.producers];
    this.producers.clear();
    for (const producer of producers) producer.releaseLeaving(this);
  }

  private refusal(cause?: unknown): InvokeError {
    const message =
      this.cancelledWith !== undefined
        ? `A stream from ${this.origin} was cancelled: ${this.cancelledWith}.`
        : `A stream from ${this.origin} was already consumed and its scope has ended; it cannot be read again.`;
    return new InvokeError(ERR_INVOKE_CANCELLED, message, undefined, cause === undefined ? undefined : { cause });
  }

  private iterate(): AsyncIterator<unknown> {
    if (this.settled !== undefined) {
      const refusal = this.refusal();
      return {
        next: () => Promise.reject(refusal),
        return: async (value?: unknown) => ({ done: true, value }),
      };
    }
    this.active++;
    const source = this.source[Symbol.asyncIterator]();
    let ended = false;
    const end = (as: Settlement): void => {
      if (ended) return;
      ended = true;
      this.active--;
      if (this.active === 0) this.settle(as);
    };
    const refuse = async (cause?: unknown): Promise<never> => {
      end("cancelled");
      let failure = cause;
      try {
        await source.return?.();
      } catch (err) {
        failure = err;
      }
      throw this.refusal(failure);
    };
    return {
      next: async (...args: [] | [unknown]) => {
        if (ended) return { done: true, value: undefined };
        if (this.cancelledWith !== undefined) return refuse();
        let step: IteratorResult<unknown>;
        try {
          step = await source.next(...args);
        } catch (err) {
          if (this.cancelledWith !== undefined) return refuse(err);
          end("failed");
          throw err;
        }
        if (this.cancelledWith !== undefined) return refuse();
        if (step.done) {
          end("finished");
          return step;
        }
        return { done: false, value: this.holdItem(step.value) };
      },
      return: async (value?: unknown) => {
        if (ended) return { done: true, value };
        try {
          return (await source.return?.(value)) ?? { done: true, value };
        } finally {
          end("cancelled");
        }
      },
      throw: async (error?: unknown) => {
        if (ended) throw error;
        try {
          if (source.throw) return await source.throw(error);
          throw error;
        } finally {
          end("failed");
        }
      },
    };
  }

  /** Each pulled item, its own streams held like this one. A bytes chunk costs one type test. */
  private holdItem(item: unknown): unknown {
    if (item instanceof Uint8Array) return item;
    if (typeof item !== "object" || item === null) return item;
    return replaceStreams(item, this.itemGuide, (stream, held, guide) => {
      if (held) return stream;
      const nested = new HeldStream(stream, this.origin, this.producers, guide);
      nested.registerWith(this.ownedBy);
      return nested.stream;
    });
  }
}

/** The owner whose dispatch issued work under `ambient`: a detached task's issuer, else its own. */
export function issuingOwnerOf(ambient: InvokeContext | undefined): StreamOwner | undefined {
  const owner = streamOwnerOf(ambient);
  return owner?.taskIssuer ?? owner;
}

/** True when `issuer` or a dispatch above it has a scope run open or owns a live held stream. */
export function issuerHolds(issuer: StreamOwner | undefined): boolean {
  for (let owner = issuer; owner; owner = owner.parent) {
    if ((owner.openRuns?.size ?? 0) > 0 || owner.ownsLive()) return true;
  }
  return false;
}

/** What a stream handed to detached work from under `issuer` keeps open. */
export function holdersOf(issuer: StreamOwner | undefined): StreamOwner[] {
  const holders: StreamOwner[] = [];
  for (let owner = issuer; owner; owner = owner.parent) {
    if (owner.openRuns) holders.push(...owner.openRuns);
    if (owner.ownsLive()) holders.push(owner);
  }
  return holders;
}

/** The value a dispatch returns, each stream leaving `from` held for `to`. */
export function holdReturned(
  value: unknown,
  from: StreamOwner,
  to: StreamOwner | undefined,
  origin: string,
  guide: WalkGuide | undefined,
): unknown {
  return replaceStreams(value, guide, (stream, held, itemGuide) => {
    if (held) {
      if (held.owner !== from) return stream;
      held.addProducer(from);
      held.registerWith(to);
      return stream;
    }
    const wrapped = new HeldStream(stream, origin, [from], itemGuide);
    wrapped.registerWith(to);
    return wrapped.stream;
  });
}

/** A scope run's produced value, each stream in it leaving the run for the holder's dispatch. */
export function holdLeavingRun(value: unknown, run: StreamOwner, holder: StreamOwner | undefined): unknown {
  return replaceStreams(value, undefined, (stream, held) => {
    if (held) {
      held.addProducer(run);
      return stream;
    }
    const wrapped = new HeldStream(stream, run.label ?? "a scope", [run], undefined);
    wrapped.registerWith(holder);
    return wrapped.stream;
  });
}

/** A detached or trigger dispatch's inputs, each stream in them owned by `target`. */
export function holdDetachedInputs(
  value: unknown,
  issuer: StreamOwner,
  target: StreamOwner,
  guide: WalkGuide | undefined,
): unknown {
  const holders = holdersOf(issuer);
  const chain = new Set<StreamOwner>();
  for (let owner: StreamOwner | undefined = issuer; owner; owner = owner.parent) chain.add(owner);
  const origin = holders.find((holder) => holder.label !== undefined)?.label ?? "a scope";
  return replaceStreams(value, guide, (stream, held, itemGuide) => {
    if (held) {
      const previous = held.owner;
      if (!previous || !chain.has(previous)) return stream;
      held.addProducer(previous);
      held.registerWith(target);
      return stream;
    }
    const wrapped = new HeldStream(stream, origin, holders, itemGuide);
    wrapped.registerWith(target);
    return wrapped.stream;
  });
}
