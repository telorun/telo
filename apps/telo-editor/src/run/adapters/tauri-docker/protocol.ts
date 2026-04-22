/**
 * Shared payload shapes for the Tauri ⇄ frontend protocol.
 *
 * These MUST stay in sync with the Rust serde types in
 * `src-tauri/src/run/docker.rs` and `src-tauri/src/run/availability.rs`.
 * Adding a variant here without updating the Rust side (or vice versa) leads
 * to silent payload drops on the receiving end, not a type error.
 *
 * Channel naming: `run:${sessionId}:stdout`, `run:${sessionId}:stderr`,
 * `run:${sessionId}:status`. The frontend adapter subscribes to all three.
 */

import type { AvailabilityReport, RunStatus } from "../../types";
import type { PortMapping } from "../../../model";

export interface OutputChunkPayload {
  chunk: string;
}

export type StatusPayload = RunStatus;
export type AvailabilityPayload = AvailabilityReport;

export interface RunStartPayload {
  sessionId: string;
  bundle: {
    entryRelativePath: string;
    files: Array<{ relativePath: string; contents: string }>;
  };
  env: Record<string, string>;
  ports: PortMapping[];
  config: unknown;
}

export interface RunStopPayload {
  sessionId: string;
}

export interface RunProbePayload {
  config: unknown;
}
