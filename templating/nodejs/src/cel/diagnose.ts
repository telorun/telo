import type { ASTNode, Environment } from "@marcbachmann/cel-js";
import { CEL_FUNCTIONS } from "./catalog.js";
import type { CallSite, DiagnosticFix, EngineDiagnostic } from "../engine.js";

/** Classifies every function call in a CEL expression against the environment's
 *  own function registry.
 *
 *  This exists because cel-js reports one sentence for three unrelated mistakes
 *  — a name that does not exist, a name called in the wrong form, and a genuine
 *  type mismatch all surface as `found no matching overload for 'f(...)'`. Two
 *  of those readings actively mislead: the message names argument types, so the
 *  repair for `startsWith(key, 'x')` looks like a cast, when the real fix is
 *  `key.startsWith('x')` and no cast helps.
 *
 *  Nothing here reads cel-js's message text. `Environment.getDefinitions()`
 *  reports every registered signature — cel-js builtins and Telo's catalog
 *  alike — with its call form and parameters, and the AST distinguishes `f(x)`
 *  from `x.f()` structurally. Name existence, call form and arity are therefore
 *  decidable by lookup, which is what keeps a cel-js version bump from silently
 *  degrading this back into the passthrough it replaced. */

/** One registered signature, reduced to what classification needs. */
interface FnEntry {
  readonly signature: string;
  readonly form: "global" | "receiver";
  /** Parameter count, excluding the receiver for a receiver form. */
  readonly arity: number;
}

export interface FunctionIndex {
  readonly byName: ReadonlyMap<string, readonly FnEntry[]>;
}

/** Determinism is Telo catalog metadata; cel-js builtins carry none. Absent
 *  means "no signal", never "deterministic" — consumers of
 *  `CallSite.deterministic` must not read undefined as a guarantee. */
const DETERMINISM: ReadonlyMap<string, boolean> = new Map(
  CEL_FUNCTIONS.map((f) => [f.name, f.deterministic]),
);

const INDEX_CACHE = new WeakMap<Environment, FunctionIndex>();

/** Registry view of an environment, memoized: environments are rebuilt per
 *  analysis path, but each is immutable once built. */
export function functionIndex(env: Environment): FunctionIndex {
  const cached = INDEX_CACHE.get(env);
  if (cached) return cached;

  const byName = new Map<string, FnEntry[]>();

  for (const fn of env.getDefinitions().functions) {
    const form = fn.receiverType === null ? "global" : "receiver";
    const entry: FnEntry = { signature: fn.signature, form, arity: fn.params?.length ?? 0 };
    const entries = byName.get(fn.name);
    if (entries) entries.push(entry);
    else byName.set(fn.name, [entry]);
  }

  const index: FunctionIndex = { byName };
  INDEX_CACHE.set(env, index);
  return index;
}

/** A call plus the nodes needed to rewrite it. Internal — `CallSite` is the
 *  shape that crosses the engine seam. */
interface RawCall extends CallSite {
  readonly receiver?: ASTNode;
  readonly args: readonly ASTNode[];
}

/** Macros the parser expands rather than dispatching through the registry, so
 *  they never appear in `getDefinitions()` and would otherwise classify as
 *  unknown names.
 *
 *  Deliberately short: most macros ARE registered, and the caller only reports
 *  this audit when the type-checker already rejected the expression, so a macro
 *  missing from here degrades to "no extra explanation" rather than to a false
 *  error on valid CEL. That is what keeps a cel-js upgrade from turning a new
 *  macro into a manifest this analyzer refuses. */
const MACROS = new Set(["optMap", "optFlatMap"]);

function isNode(v: unknown): v is ASTNode {
  return typeof v === "object" && v !== null && "op" in (v as Record<string, unknown>);
}

/** Every non-macro call in the expression, in source order. */
function collectCalls(root: ASTNode, index: FunctionIndex): RawCall[] {
  const out: RawCall[] = [];
  visit(root);
  return out.sort((a, b) => a.start - b.start);

  function visit(node: ASTNode): void {
    const args = node.args as unknown;
    if (node.op === "call" || node.op === "rcall") {
      const tuple = args as unknown[];
      const name = tuple[0];
      if (typeof name === "string" && !MACROS.has(name)) {
        const receiver = node.op === "rcall" ? tuple[1] : undefined;
        const rawArgs = node.op === "rcall" ? tuple[2] : tuple[1];
        const callArgs = (Array.isArray(rawArgs) ? rawArgs : []).filter(isNode);
        out.push({
          name,
          form: node.op === "rcall" ? "receiver" : "global",
          arity: callArgs.length,
          start: node.start,
          end: node.end,
          ...(index.byName.has(name) ? { deterministic: DETERMINISM.get(name) } : {}),
          ...(isNode(receiver) ? { receiver } : {}),
          args: callArgs,
        });
      }
    }
    for (const arg of Array.isArray(args) ? args : [args]) {
      if (isNode(arg)) visit(arg);
      else if (Array.isArray(arg)) for (const item of arg) if (isNode(item)) visit(item);
    }
  }
}

/** Node shapes that can carry a `.` on their right without reparsing
 *  differently. Everything else — an operator expression, a literal that would
 *  sit against the dot — is parenthesized when moved into receiver position. */
const SELF_DELIMITING = new Set<string>(["id", ".", ".?", "call", "rcall", "[]", "[?]"]);

/** Source text of a node. When it is about to become a receiver it may need
 *  parentheses: an identifier, member chain, index or call is self-delimiting,
 *  but an operator expression or a bare literal against a `.` is not. */
function nodeText(source: string, node: ASTNode, asReceiver = false): string {
  const text = source.slice(node.start, node.end);
  if (!asReceiver) return text;
  return SELF_DELIMITING.has(node.op) ? text : `(${text})`;
}

/** The same call written in the other form, or undefined when the shape does
 *  not allow it (a global call with no arguments has no receiver to move). */
function transpose(source: string, call: RawCall): string | undefined {
  if (call.form === "global") {
    const [first, ...rest] = call.args;
    if (!first) return undefined;
    const argText = rest.map((a) => nodeText(source, a));
    return `${nodeText(source, first, true)}.${call.name}(${argText.join(", ")})`;
  }
  if (!call.receiver) return undefined;
  const argText = [nodeText(source, call.receiver), ...call.args.map((a) => nodeText(source, a))];
  return `${call.name}(${argText.join(", ")})`;
}

/** Splice a rewritten call back into the full source. The fix always carries
 *  the whole corrected source, so a consumer applies it by replacing the
 *  scalar. */
function spliceFix(source: string, call: RawCall, rewritten: string): DiagnosticFix {
  return { replacement: source.slice(0, call.start) + rewritten + source.slice(call.end) };
}

/** Replace only the called name, leaving arguments untouched. The offset is
 *  derived rather than searched: a receiver whose own text contains the name
 *  (`slice.slice(1)`) would defeat a first-occurrence replace. */
function renameFix(source: string, call: RawCall, to: string): DiagnosticFix | undefined {
  const searchFrom = call.receiver ? call.receiver.end : call.start;
  const at = source.indexOf(call.name, searchFrom);
  if (at === -1 || at >= call.end) return undefined;
  return { replacement: source.slice(0, at) + to + source.slice(at + call.name.length) };
}

/** Arity the call would need in the other form: moving a receiver in adds an
 *  argument, moving it out removes one. */
function transposedArity(call: RawCall): number {
  return call.form === "global" ? call.arity - 1 : call.arity + 1;
}

function accepts(entries: readonly FnEntry[], form: CallSite["form"], arity: number): boolean {
  return entries.some((e) => e.form === form && e.arity === arity);
}

const listOf = (names: readonly string[]): string => [...new Set(names)].sort().join(", ");

/** Names registered in exactly the form and arity the author wrote — the only
 *  ones that could replace this call with no further edits. Ranked by shared
 *  prefix, which is what reaches `nowIso` from `now`; edit distance never
 *  would (3 characters against a 3-character name). Returns [] when nothing
 *  shares a prefix, so the caller lists what is legal here instead of
 *  guessing. */
function candidates(call: RawCall, index: FunctionIndex): string[] {
  const written = call.name.toLowerCase();
  return callableHere(call, index)
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.startsWith(written) || written.startsWith(lower);
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Every name callable in exactly the position written — same form, same
 *  argument count. Arity is what makes the list usable: a receiver's type is
 *  `dyn` at analysis time so every method is nominally reachable, and printing
 *  all forty says nothing. */
function callableHere(call: RawCall, index: FunctionIndex): string[] {
  const names: string[] = [];
  for (const [name, entries] of index.byName) {
    if (name !== call.name && accepts(entries, call.form, call.arity)) names.push(name);
  }
  return names;
}

function signaturesOf(name: string, index: FunctionIndex): string[] {
  return (index.byName.get(name) ?? []).map((e) => e.signature);
}

/** Spread-friendly optional `fix`, so an undecidable rewrite simply omits the
 *  field rather than carrying `undefined` into the diagnostic. */
const withFix = (fix: DiagnosticFix | undefined): { fix?: DiagnosticFix } => (fix ? { fix } : {});

export interface CallAudit {
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly calls: readonly CallSite[];
  /** Names that resolve, but that no registered signature accepts as written.
   *  The caller appends their signatures to a type-check failure it could not
   *  otherwise explain. */
  readonly unresolved: readonly string[];
}

/** Classify every call in `ast`. Runs unconditionally rather than only after a
 *  failed type-check, because a type-check reports its first error and stops:
 *  an expression with two bad calls would otherwise fix one, re-run, and
 *  discover the next. */
export function auditCalls(source: string, ast: ASTNode, env: Environment): CallAudit {
  const index = functionIndex(env);
  const diagnostics: EngineDiagnostic[] = [];
  const unresolved: string[] = [];
  const calls = collectCalls(ast, index);

  for (const call of calls) {
    const entries = index.byName.get(call.name);
    const noun = call.form === "receiver" ? "method" : "function";

    if (!entries) {
      const near = candidates(call, index);
      const hint =
        near.length > 0
          ? `Closest taking ${call.arity} argument${call.arity === 1 ? "" : "s"}: ${near
              .slice(0, 5)
              .map((n) => `\`${n}\``)
              .join(", ")}.`
          : `Every ${noun} taking ${call.arity} argument${call.arity === 1 ? "" : "s"}: ${listOf(callableHere(call, index))}.`;
      diagnostics.push({
        code: "CEL_UNKNOWN_FUNCTION",
        message: `there is no ${noun} \`${call.name}\`. ${hint} Full list: \`telo cel functions\`.`,
        // A single candidate is an unambiguous rename; several are a menu, and
        // applying an arbitrary one would be a guess wearing a fix's clothes.
        ...(near.length === 1 ? withFix(renameFix(source, call, near[0]!)) : {}),
      });
      continue;
    }

    if (accepts(entries, call.form, call.arity)) continue;

    const otherForm = call.form === "global" ? "receiver" : "global";
    if (accepts(entries, otherForm, transposedArity(call))) {
      const rewritten = transpose(source, call);
      const written = source.slice(call.start, call.end);
      diagnostics.push({
        code: "CEL_WRONG_CALL_FORM",
        message:
          `\`${call.name}\` is ${
            call.form === "global"
              ? "a method, not a global function — call it on the value"
              : "a global function, not a method — pass the value to it"
          }:` +
          (rewritten ? `\n  write:  ${rewritten}\n  not:    ${written}` : "") +
          `\nRegistered: ${listOf(signaturesOf(call.name, index))}.`,
        ...withFix(rewritten ? spliceFix(source, call, rewritten) : undefined),
      });
      continue;
    }

    unresolved.push(call.name);
  }

  return {
    diagnostics,
    calls: calls.map(({ receiver: _receiver, args: _args, ...site }) => site),
    unresolved,
  };
}

/** Registered signatures for names a type-check failure mentions, so the
 *  residual says what the function actually accepts rather than only echoing
 *  what the author wrote. */
export function explainUnresolved(names: readonly string[], env: Environment): string {
  const index = functionIndex(env);
  const signatures = [...new Set(names)].flatMap((n) => signaturesOf(n, index));
  return signatures.length > 0 ? ` Registered: ${listOf(signatures)}.` : "";
}
