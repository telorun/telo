/**
 * **Whether a function is deterministic, and whether it needs its host** —
 * derived for a function written in CEL, claimed by a native one.
 *
 * A body's two flags follow from everything it calls: a catalog function carries
 * its own (`now()` is non-deterministic, `sha256()` host-backed), and a module
 * function carries what this derivation says about it, recursively. A native
 * callable is always host-backed — the analyzer never has its code — and is
 * deterministic only where the kind supplying its controller claims
 * `deterministic: true`. Derived rather than declared, so a body's flags can
 * never be written wrong.
 *
 * Every answer carries the CHAIN to the leaf that decided it (`Billing.isStale →
 * now()`), because a flag is only actionable when the author can see which call
 * made it. Recomputed per analysis rather than cached per expression: a rule
 * calling a body must see `now()` the moment it is added to the body, with no
 * edit to the rule.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { auditCalls, buildCelEnvironment, resolveModuleCalls } from "@telorun/templating";
import { moduleCallNamesOf } from "./module-call-names.js";
import type { ModuleFunctionIndex } from "./module-function-index.js";

export interface CallableFlags {
  readonly deterministic: boolean;
  readonly hostBacked: boolean;
  /** The calls from the function to the leaf that makes it non-deterministic,
   *  as written — empty when it is deterministic. */
  readonly nondeterministicVia: readonly string[];
  /** The calls from the function to the leaf that needs the host — empty when
   *  it does not. */
  readonly hostBackedVia: readonly string[];
}

interface Derived {
  readonly deterministic: boolean;
  readonly hostBacked: boolean;
  /** The chain BELOW the function itself. */
  readonly nondeterministicTail: readonly string[];
  readonly hostBackedTail: readonly string[];
}

/** A function the analyzer is still deriving: a call reaching it again is a
 *  cycle, which `DEPENDENCY_CYCLE` reports, and contributes nothing here — the
 *  function being derived accounts for its own calls. */
const IN_PROGRESS: Derived = {
  deterministic: true,
  hostBacked: false,
  nondeterministicTail: [],
  hostBackedTail: [],
};

let parseEnv: ReturnType<typeof buildCelEnvironment> | undefined;

/** A chain rendered for a message. */
export function renderChain(via: readonly string[]): string {
  return via.join(" → ");
}

export class CallableFlagsIndex {
  private readonly derived = new Map<ResourceManifest, Derived>();
  /** The functions being derived, outermost first. */
  private readonly inProgress: ResourceManifest[] = [];
  /** Per derivation depth, the shallowest in-progress function it has read. A
   *  result that read one shallower than itself lacks that function's own calls,
   *  so it is not cached: whichever function is asked about first in a cycle
   *  gets a complete answer, and so does every other one asked about later. */
  private readonly readInProgressAt: number[] = [];

  constructor(
    private readonly functions: ModuleFunctionIndex,
    private readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>,
  ) {}

  /** The flags of the function `qualified`, written in `caller`'s module,
   *  reaches — or undefined where it reaches no function. */
  ofCall(caller: ResourceManifest, qualified: string): CallableFlags | undefined {
    const resolution = this.functions.resolve(caller, qualified);
    if (resolution.status !== "resolved") return undefined;
    return this.withHead(this.derive(resolution.manifest), qualified);
  }

  /** The flags of a callable resource itself, its chain starting at `label`. */
  ofResource(manifest: ResourceManifest, label: string): CallableFlags {
    return this.withHead(this.derive(manifest), label);
  }

  private withHead(derived: Derived, head: string): CallableFlags {
    return {
      deterministic: derived.deterministic,
      hostBacked: derived.hostBacked,
      nondeterministicVia: derived.deterministic ? [] : [head, ...derived.nondeterministicTail],
      hostBackedVia: derived.hostBacked ? [head, ...derived.hostBackedTail] : [],
    };
  }

  private derive(manifest: ResourceManifest): Derived {
    const known = this.derived.get(manifest);
    if (known) return known;
    const cycleAt = this.inProgress.indexOf(manifest);
    if (cycleAt !== -1) {
      const reader = this.inProgress.length - 1;
      this.readInProgressAt[reader] = Math.min(this.readInProgressAt[reader]!, cycleAt);
      return IN_PROGRESS;
    }
    const depth = this.inProgress.length;
    this.inProgress.push(manifest);
    this.readInProgressAt[depth] = Infinity;
    try {
      const result = this.deriveUncached(manifest);
      const readAt = this.readInProgressAt[depth]!;
      // Read a function still being derived above this one: the result lacks
      // that function's own calls, so it answers for this derivation only.
      if (readAt >= depth) this.derived.set(manifest, result);
      else if (depth > 0) {
        this.readInProgressAt[depth - 1] = Math.min(this.readInProgressAt[depth - 1]!, readAt);
      }
      return result;
    } finally {
      this.inProgress.pop();
      this.readInProgressAt.length = depth;
    }
  }

  private deriveUncached(manifest: ResourceManifest): Derived {
    const body = this.functions.bodyOf(manifest);
    if (!body) {
      return {
        deterministic: this.functions.claimsDeterministic(manifest),
        hostBacked: true,
        nondeterministicTail: [],
        hostBackedTail: [],
      };
    }

    let deterministic = true;
    let hostBacked = false;
    let nondeterministicTail: readonly string[] = [];
    let hostBackedTail: readonly string[] = [];
    const source = body.source;
    if (source === undefined) {
      return { deterministic, hostBacked, nondeterministicTail, hostBackedTail };
    }

    let ast;
    try {
      parseEnv ??= buildCelEnvironment();
      ast = parseEnv.parse(source).ast;
    } catch {
      // A body that does not parse is `CEL_SYNTAX_ERROR`'s to report, and calls
      // nothing anything could evaluate.
      return { deterministic, hostBacked, nondeterministicTail, hostBackedTail };
    }
    resolveModuleCalls(ast, moduleCallNamesOf(this.moduleCallNames, manifest));
    const calls = auditCalls(source, ast, parseEnv, (qualified) =>
      this.ofCall(manifest, qualified),
    ).calls;
    for (const call of calls) {
      if (call.moduleCall) {
        // A call reaching no function is `FUNCTION_UNRESOLVED`'s to report; what
        // it would do is unknown, so it makes no promise either way.
        const flags = this.ofCall(manifest, call.name) ?? {
          deterministic: false,
          hostBacked: true,
          nondeterministicVia: [call.name],
          hostBackedVia: [call.name],
        };
        if (deterministic && !flags.deterministic) {
          deterministic = false;
          nondeterministicTail = flags.nondeterministicVia;
        }
        if (!hostBacked && flags.hostBacked) {
          hostBacked = true;
          hostBackedTail = flags.hostBackedVia;
        }
        continue;
      }
      if (deterministic && call.deterministic === false) {
        deterministic = false;
        nondeterministicTail = [`${call.name}()`];
      }
      if (!hostBacked && call.hostBacked === true) {
        hostBacked = true;
        hostBackedTail = [`${call.name}()`];
      }
    }
    return { deterministic, hostBacked, nondeterministicTail, hostBackedTail };
  }
}
