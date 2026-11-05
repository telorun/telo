import type { LoadedGraph } from "@telorun/analyzer";
import {
  appendFailureFrame,
  droppedFramesOf,
  failureFramesOf,
  raisedAtOf,
  type FailureFrame,
} from "@telorun/sdk";
import { writtenPositionOf, type DispatchCaller } from "./failure-location.js";

/**
 * The kernel half of a failure's trace (`kernel/specs/invocation-contract.md` §5.5):
 * the frame of a resource at a pointer into its declaration, positioned under the
 * rule a failure's `location` follows, and the frames a dispatch exit adds. Built
 * on the failure path only.
 */

/** A resource as a frame names it. `pointer` is stated only when there is one;
 *  `""` is the resource itself. */
export function frameOf(
  subject: DispatchCaller,
  pointer: string | undefined,
  graph: LoadedGraph | undefined,
): FailureFrame {
  const position =
    graph && subject.declaration ? writtenPositionOf(graph, subject.declaration, pointer) : undefined;
  const module = position?.file ?? subject.module ?? sourceOf(subject);
  return {
    kind: subject.kind,
    name: subject.name,
    ...(module !== undefined ? { module } : {}),
    ...(pointer !== undefined ? { pointer } : {}),
    ...(position ? { position: { line: position.line, column: position.column } } : {}),
  };
}

function sourceOf(subject: DispatchCaller): string | undefined {
  const source = subject.declaration?.metadata?.source;
  return typeof source === "string" ? source : undefined;
}

/**
 * What a failure leaving a dispatch gains: the target's frame when it has no trace
 * yet — pointed at where the target raised it, else at the target itself — and
 * always the caller's, pointed at the call site. A dispatch stating no call site
 * gives the caller's frame without a pointer; no caller, no frame.
 */
export function recordDispatchExit(
  err: unknown,
  graph: () => LoadedGraph | undefined,
  target: (() => DispatchCaller) | undefined,
  caller: DispatchCaller | undefined,
  calledAt: string | undefined,
): void {
  if (target && failureFramesOf(err).length === 0 && droppedFramesOf(err) === 0) {
    appendFailureFrame(err, () => frameOf(target(), raisedAtOf(err) ?? "", graph()));
  }
  if (caller) appendFailureFrame(err, () => frameOf(caller, calledAt, graph()));
}
