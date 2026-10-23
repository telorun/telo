import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import { InvokeError, integerInput, resolveInvocableDispatcher } from "@telorun/sdk";
import { runBounded } from "./bounded-runner.js";
import { isContentPart, isMediaPart, type ContentPart, type MediaPart } from "./content.js";
import type { Message } from "./types.js";

/**
 * The content resolver of the four operations: what turns a media part's
 * reference into something a model can be sent. A part whose `uri` names a
 * scheme the resolver lists is replaced, in the messages sent to the model and
 * nowhere else, by the part the resolver answers with; any other part reaches
 * the model as written. The conversation an operation returns or streams keeps
 * the reference.
 */

/** An operation's `resolver`, as its manifest declares it. */
export interface ContentResolverConfig {
  /** The URI schemes resolved, lowercase. */
  schemes: string[];
  /** The resource asked: a reference, an inline declaration, or — once the
   *  kernel has injected it — the live instance. */
  invoke: unknown;
  /** CEL mapping from `part` and `context` to the resolver's input. */
  inputs: unknown;
  /** CEL expression from the resolver's `result` to the replacement part. */
  result: unknown;
  /** How many resolutions run at once; a CEL-computed one arrives as an int64. */
  concurrency?: unknown;
}

export const DEFAULT_RESOLVER_CONCURRENCY = 4;

const REASONS = {
  siblingFailed: "another reference of the same call could not be resolved",
  abandoned: "the call stopped before its references were resolved",
};

type Reference = MediaPart & { uri: string };
type Answers = ReadonlyMap<string, ContentPart>;

/** The parts a caller may send, and so the parts an answer may be. */
const SENDABLE = new Set(["text", "image", "audio", "video", "file"]);

/** The configured bound as a number. */
export function resolverConcurrency(value: unknown, label: string): number {
  if (value === undefined) return DEFAULT_RESOLVER_CONCURRENCY;
  const limit = integerInput(value);
  if (limit !== undefined && limit >= 1) return limit;
  throw new Error(`${label}: 'resolver.concurrency' must be an integer of at least 1, got ${String(value)}.`);
}

/** A uri's scheme, lowercased: the text before its first `:`, or none without one. */
function schemeOf(uri: string): string | undefined {
  const colon = uri.indexOf(":");
  return colon === -1 ? undefined : uri.slice(0, colon).toLowerCase();
}

/**
 * The resolution of one invocation of an operation: each distinct uri the
 * resolver claims is resolved once, on first sight, and the answer reused for
 * every later part naming it — never across invocations. The uris first seen
 * together run through the module's bounded runner, at most `concurrency` at a
 * time, started in message order; a uri already in flight or resolved is
 * awaited, never asked again. The first failure cancels the resolutions still
 * running and starts no queued one. With no resolver declared, every message
 * passes through as it is.
 */
export class ContentResolution {
  /** Each uri seen, to the batch that resolves it. */
  private readonly batches = new Map<string, Promise<Answers>>();

  private readonly schemes: ReadonlySet<string>;

  private readonly concurrency: number;

  private readonly dispatch?: (
    inputs: Record<string, unknown>,
    ctx?: InvokeContext,
  ) => Promise<unknown>;

  /**
   * @param config   the operation's `resolver`, when it declares one
   * @param ctx      the operation's resource context, which evaluates the mappings
   * @param label    the operation's identity, for messages (`Ai.Text "x"`)
   * @param context  the caller's `context` input
   * @param invokeCtx the operation's invocation, whose cancellation reaches the resolver
   */
  constructor(
    private readonly config: ContentResolverConfig | undefined,
    private readonly ctx: ResourceContext,
    private readonly label: string,
    private readonly context: Record<string, unknown>,
    private readonly invokeCtx: InvokeContext | undefined,
  ) {
    this.schemes = new Set(config?.schemes ?? []);
    this.concurrency = resolverConcurrency(config?.concurrency, label);
    // Resolved for every invocation, so an unusable `resolver.invoke` fails the
    // call whether or not a message carries a reference.
    this.dispatch =
      config && resolveInvocableDispatcher(config.invoke, ctx, () => `${label}: 'resolver'`);
  }

  /** `messages` as the model is sent them. */
  async messages(messages: readonly Message[]): Promise<Message[]> {
    const references = messages.flatMap((message) => this.references(message));
    await this.resolveAll(references);
    return Promise.all(messages.map((message) => this.sent(message)));
  }

  /** One message as the model is sent it: the same object when nothing in it is claimed. */
  async message(message: Message): Promise<Message> {
    await this.resolveAll(this.references(message));
    return this.sent(message);
  }

  private references(message: Message): Reference[] {
    return typeof message.content === "string"
      ? []
      : message.content.filter((part): part is Reference => this.claims(part));
  }

  private claims(part: ContentPart): part is Reference {
    if (this.schemes.size === 0 || !isMediaPart(part) || typeof part.uri !== "string") return false;
    const scheme = schemeOf(part.uri);
    return scheme !== undefined && this.schemes.has(scheme);
  }

  /** Resolve every uri among `references` not yet seen, as one batch, and wait
   *  for every batch any of them belongs to. */
  private async resolveAll(references: readonly Reference[]): Promise<void> {
    const fresh = new Map<string, Reference>();
    for (const part of references) {
      if (!this.batches.has(part.uri) && !fresh.has(part.uri)) fresh.set(part.uri, part);
    }
    if (fresh.size > 0) {
      const batch = this.run([...fresh.values()]);
      for (const uri of fresh.keys()) this.batches.set(uri, batch);
    }
    await Promise.all(new Set(references.map((part) => this.batches.get(part.uri)!)));
  }

  private async run(parts: readonly Reference[]): Promise<Answers> {
    const answers = new Map<string, ContentPart>();
    const steps = runBounded(parts, this.concurrency, this.invokeCtx, REASONS, (part, ctx) =>
      this.ask(part, ctx),
    );
    for await (const step of steps) {
      if ("outcome" in step) answers.set(parts[step.index]!.uri, step.outcome);
    }
    return answers;
  }

  private async sent(message: Message): Promise<Message> {
    const content = message.content;
    if (typeof content === "string" || !content.some((part) => this.claims(part))) return message;
    const parts: ContentPart[] = [];
    for (const part of content) {
      if (!this.claims(part)) {
        parts.push(part);
        continue;
      }
      const resolved = (await this.batches.get(part.uri)!).get(part.uri)!;
      // A breakpoint marks the place the reference stood, whatever replaced it.
      parts.push(
        part.cacheBreakpoint === true ? ({ ...resolved, cacheBreakpoint: true } as ContentPart) : resolved,
      );
    }
    return { ...message, content: parts };
  }

  private async ask(part: Reference, invokeCtx: InvokeContext | undefined): Promise<ContentPart> {
    const config = this.config!;
    const inputs = this.ctx.expandValue(config.inputs, { part, context: this.context });
    const result = await this.dispatch!(inputs, invokeCtx);
    const answer: unknown = this.ctx.expandValue(config.result, { result });
    const refusal = this.refusal(answer);
    if (refusal !== undefined) {
      throw new InvokeError(
        "ERR_CONTENT_RESOLUTION_INVALID",
        `${this.label}: the resolver's answer for "${part.uri}" ${refusal}`,
        { uri: part.uri },
      );
    }
    return answer as ContentPart;
  }
  /** Why an answer cannot replace a reference, or nothing when it can. */
  private refusal(answer: unknown): string | undefined {
    if (!isContentPart(answer) || !SENDABLE.has(answer.type)) {
      return "is not a part a caller may send. 'resolver.result' must give a text, image, audio, video or file part, as Ai.ContentPart declares it.";
    }
    const uri = (answer as { uri?: unknown }).uri;
    const scheme = typeof uri === "string" ? schemeOf(uri) : undefined;
    if (scheme !== undefined && this.schemes.has(scheme)) {
      return `is a reference again, by the scheme "${scheme}" the resolver itself answers for. 'resolver.result' must give the content, or a reference the model can read.`;
    }
    return undefined;
  }
}
