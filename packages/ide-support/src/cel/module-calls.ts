/**
 * **Module calls inside a CEL body** — `Self.total(items)`, `Billing.isStale(x)`.
 *
 * In the tree an editor parses, a module call is a receiver-style call whose
 * receiver is a plain identifier naming a module: `Self`, the module's own name
 * or an import alias. Which identifiers those are is the scope's answer
 * (`CelScope.moduleNames`), never a guess from the spelling, and what a call
 * resolves to is the analyzer's (`CelScope.moduleFunction`), so completion,
 * hover, signature help and go-to-declaration all name the function `telo check`
 * binds the call to.
 */
import {
  renderChain,
  type CallableFlags,
  type CelNode,
  type CelScope,
  type ResolvedFunction,
} from "@telorun/analyzer";
import { walkCel } from "../cel-chain.js";
import { schemaTypeName } from "./symbols.js";

/** One module call written in a CEL body. */
export interface ModuleCallSite {
  node: Extract<CelNode, { kind: "methodCall" }>;
  receiver: string;
  name: string;
  /** `Receiver.name`, as the analyzer keys a call. */
  qualified: string;
  receiverRange: [number, number];
  /** The function name alone, in document offsets. */
  nameRange: [number, number];
}

/** The span of a method's name after its receiver, read off the document text —
 *  the parsed node carries no span for the name itself. */
function nameRangeOf(
  text: string,
  node: Extract<CelNode, { kind: "methodCall" }>,
): [number, number] | undefined {
  const at = text.indexOf(node.name, node.receiver.range[1]);
  return at >= 0 && at + node.name.length <= node.range[1] ? [at, at + node.name.length] : undefined;
}

/** Whether `node` is a module call: a method call whose receiver is a plain
 *  identifier `isModule` accepts. The one recognizer every editor feature reads,
 *  mirroring the templating rule — `a.Billing.format(x)` is an ordinary method
 *  call, since its receiver is a field access. */
export function isModuleCallNode(
  node: CelNode,
  isModule: (receiver: string) => boolean,
): node is Extract<CelNode, { kind: "methodCall" }> & {
  receiver: Extract<CelNode, { kind: "ident" }>;
} {
  return node.kind === "methodCall" && node.receiver.kind === "ident" && isModule(node.receiver.name);
}

/** Every call in `ast` whose receiver `isModule` accepts. */
export function moduleCallSites(
  text: string,
  ast: CelNode,
  isModule: (receiver: string) => boolean,
): ModuleCallSite[] {
  const out: ModuleCallSite[] = [];
  walkCel(ast, (node) => {
    if (!isModuleCallNode(node, isModule)) return;
    const nameRange = nameRangeOf(text, node);
    if (!nameRange) return;
    out.push({
      node,
      receiver: node.receiver.name,
      name: node.name,
      qualified: `${node.receiver.name}.${node.name}`,
      receiverRange: node.receiver.range,
      nameRange,
    });
  });
  return out;
}

/** The module call whose receiver or name the cursor is on — the innermost, when
 *  one call's argument holds another. */
export function moduleCallAt(
  text: string,
  ast: CelNode,
  offset: number,
  scope: CelScope,
): (ModuleCallSite & { onReceiver: boolean }) | undefined {
  const within = (range: [number, number]) => offset >= range[0] && offset <= range[1];
  let hit: (ModuleCallSite & { onReceiver: boolean }) | undefined;
  for (const site of moduleCallSites(text, ast, (receiver) => scope.moduleNames.has(receiver))) {
    if (within(site.nameRange)) hit = { ...site, onReceiver: false };
    else if (within(site.receiverRange)) hit = { ...site, onReceiver: true };
  }
  return hit;
}

/** A function's signature as a reader sees it, with each parameter's span inside
 *  the label — the shape signature help highlights the active parameter by. */
export function functionSignature(
  qualified: string,
  fn: ResolvedFunction,
): { label: string; parameters: Array<{ label: [number, number]; documentation?: string }> } {
  let label = `${qualified}(`;
  const parameters: Array<{ label: [number, number]; documentation?: string }> = [];
  fn.params.forEach((param, index) => {
    if (index > 0) label += ", ";
    const text = `${param.name}${param.optional ? "?" : ""}: ${schemaTypeName(param.schema) ?? "dyn"}`;
    const description = param.schema?.description;
    parameters.push({
      label: [label.length, label.length + text.length],
      ...(typeof description === "string" ? { documentation: description } : {}),
    });
    label += text;
  });
  label += `) → ${schemaTypeName(fn.returns) ?? fn.celType}`;
  return { label, parameters };
}

/** What a reader is told a function promises: its description and derived
 *  determinism, naming the chain to the leaf that decided it. */
export function describeFunction(fn: ResolvedFunction, flags: CallableFlags | undefined): string {
  const lines: string[] = [];
  const description = (fn.manifest.metadata as { description?: unknown } | undefined)?.description;
  if (typeof description === "string" && description) lines.push(description);
  if (flags) {
    const facts: string[] = [];
    facts.push(
      flags.deterministic
        ? "deterministic"
        : `non-deterministic${flags.nondeterministicVia.length ? ` (${renderChain(flags.nondeterministicVia)})` : ""}`,
    );
    if (flags.hostBacked) {
      facts.push(`host-backed${flags.hostBackedVia.length ? ` (${renderChain(flags.hostBackedVia)})` : ""}`);
    }
    lines.push(facts.join(" · "));
  }
  return lines.join("\n\n");
}
