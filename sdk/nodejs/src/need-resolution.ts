import type { ResourceHandle } from "./resource-instance.js";

/**
 * A need's constraints — what a fulfilment must be. `version` is a range in
 * explicit comparators (`>=15.0.0`); `features` the names it must carry.
 */
export interface NeedConstraints {
  version?: string;
  features?: string[];
}

/**
 * What `ctx.resolveNeed(pointer)` answers for a reference slot of the asking
 * resource's own kind that holds a need's fulfilment (`Need.Resolve`).
 *
 * `constraints` and `parameters` are those of the OUTERMOST need of the
 * whole-forward chain the fulfilment came through — what the kernel enforces.
 * A slot referencing a self-supplied fulfilment directly has neither.
 */
export interface NeedResolution {
  /** The fulfilment's resource handle. */
  target: ResourceHandle;
  /** The fulfilment's fields, as CEL values. */
  fields: Record<string, unknown>;
  /** The names of the fields that are sensitive as delivered. */
  sensitive: string[];
  constraints: NeedConstraints;
  parameters?: Record<string, unknown>;
  /** For a need of a kernel-declared address type (`Telo.PublicUrl`,
   *  `Telo.PublicHostPattern`): the number of the port its `port` parameter
   *  names, as the application resolved it. */
  port?: number;
}

/**
 * What a consumer found on the real thing behind a fulfilment, reported through
 * `ctx.verifyNeed(pointer, observation)` (`Need.Verify`) — one member per
 * constraint its slot `observes`: the actual version as semver text, the
 * features present. The kernel compares; no controller compares a range.
 */
export interface NeedObservation {
  version?: string;
  features?: string[];
}
