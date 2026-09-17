/**
 * Signature help inside a CEL body: the signature of the module call the cursor
 * is writing the arguments of, with the argument under the cursor active.
 *
 * TEXTUAL, like completion's cursor chain, because it fires while the call is
 * unfinished — `Billing.total(items, ` does not parse — and a parse-first
 * approach would go silent exactly when help is asked for. The scan tracks
 * brackets and string literals, so a comma inside a list or a quoted string is
 * not an argument separator. Which receivers are modules, and what a call binds
 * to, stay the analyzer's answers.
 */
import {
  parseToAst,
  type AstDocument,
  type ManifestAnalysis,
} from "@telorun/analyzer";
import type { SignatureHelpResult } from "../types.js";
import { bodyStart } from "../cel/cursor-chain.js";
import { describeFunction, functionSignature } from "../cel/module-calls.js";
import { resolveNodeAtPosition } from "../completions/resolve-node.js";
import { docIdentity } from "../doc-identity.js";

interface Frame {
  /** `Receiver.name` for a call's parenthesis; undefined for any other bracket. */
  call?: { receiver: string; name: string };
  commas: number;
}

/** `Receiver.name` immediately before a `(`, where the receiver is a bare
 *  identifier — not a member of something else, which templating reads as an
 *  ordinary method call (`a.Billing.format(`). */
const CALLEE = /(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/** The innermost bracket still open at the end of `source`. */
function openFrame(source: string): Frame | undefined {
  const stack: Frame[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'") {
      // Skip the literal, honouring escapes; an unterminated one runs to the end.
      for (i++; i < source.length && source[i] !== c; i++) {
        if (source[i] === "\\") i++;
      }
      continue;
    }
    if (c === "(") {
      const match = CALLEE.exec(source.slice(0, i));
      stack.push({ ...(match ? { call: { receiver: match[1]!, name: match[2]! } } : {}), commas: 0 });
    } else if (c === "[" || c === "{") {
      stack.push({ commas: 0 });
    } else if (c === ")" || c === "]" || c === "}") {
      stack.pop();
    } else if (c === "," && stack.length > 0) {
      stack[stack.length - 1]!.commas++;
    }
  }
  return stack[stack.length - 1];
}

export function buildSignatureHelp(
  text: string,
  line: number,
  character: number,
  docs: AstDocument[] | undefined,
  analysis: ManifestAnalysis | undefined,
): SignatureHelpResult | undefined {
  const query = analysis?.celScope;
  if (!query) return undefined;
  const astDocs = docs ?? parseToAst(text);
  const resolved = resolveNodeAtPosition(text, astDocs, line, character);
  if (!resolved?.cel) return undefined;
  const { segment, offset } = resolved.cel;

  const start = bodyStart(text, segment);
  const frame = openFrame(segment.source.slice(0, Math.max(0, offset - start)));
  if (!frame?.call) return undefined;

  const identity = docIdentity(astDocs[resolved.docIndex]);
  const resource = query.resourceFor(identity.kind, identity.name);
  if (!resource) return undefined;
  const scope = query.scopeAt(resource, resolved.concretePath ?? "");
  if (!scope.moduleNames.has(frame.call.receiver)) return undefined;
  const qualified = `${frame.call.receiver}.${frame.call.name}`;
  const fn = scope.moduleFunction(qualified);
  if (!fn) return undefined;

  const signature = functionSignature(qualified, fn);
  const documentation = describeFunction(fn, scope.moduleCallFlags(qualified));
  return {
    signatures: [
      {
        label: signature.label,
        parameters: signature.parameters,
        ...(documentation ? { documentation } : {}),
      },
    ],
    activeSignature: 0,
    activeParameter: Math.min(frame.commas, Math.max(0, fn.params.length - 1)),
  };
}
