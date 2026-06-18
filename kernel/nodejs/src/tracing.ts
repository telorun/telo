import { randomBytes } from "node:crypto";
import type { Tracer } from "@telorun/sdk";

/**
 * The kernel's invocation tracer: a monotonic counter plus the `enabled` gate a
 * debug consumer flips on attach (`Kernel.setTracing`). One instance per kernel,
 * shared by reference across the whole context tree, so invocation ids are unique
 * within the run and `enabled` toggles everywhere at once.
 *
 * When `enabled` is `false` (the default), `invoke` skips id minting and the extra
 * ALS scope entirely — tracing costs nothing until someone is watching.
 */
export class KernelTracer implements Tracer {
  enabled = false;
  #next = 0;

  next(): number {
    this.#next += 1;
    return this.#next;
  }

  /** A fresh OTel-compatible 16-byte hex trace id. Globally unique, so a trace
   *  stays identifiable once it crosses process boundaries. */
  newTraceId(): string {
    return randomBytes(16).toString("hex");
  }
}
