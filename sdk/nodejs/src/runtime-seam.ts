import type { Stream } from "./stream.js";

/**
 * The host's own manifest machinery, exposed to a controller as `ctx.runtime`:
 * **run a manifest**, **analyze a manifest**.
 *
 * It lives on the module-author surface because the modules that need it are
 * ordinary modules — `test` runs a child manifest, `assert`'s `Manifest` kind
 * analyzes one — and reaching into a kernel-internal import to do that would make
 * kernel internals an unversioned ABI between a published artifact and whatever
 * kernel loads it. It is deliberately not test-shaped: a workflow engine running
 * sub-manifests, a supervisor, a hub validating a published module and CI tooling
 * all want one half or the other.
 *
 * Every shape crossing this boundary is plain serializable data or a
 * {@link Stream}, so no kernel or analyzer class is part of the contract and a
 * kernel in any language can implement it. **Isolation is the kernel's choice** —
 * an in-process child kernel today, a subprocess later — which is what keeps
 * process-global host state an implementation detail rather than something a
 * caller has to reason about.
 */
export interface RuntimeSeam {
  /**
   * Load and start `source` as a child manifest, isolated from the caller's.
   *
   * Resolves once the child has **started**, not once it has finished, so the
   * caller can consume its output while it runs; completion is
   * {@link RuntimeRun.exitCode}. A child that fails to load is not an exception
   * here — it settles `exitCode` non-zero with the failure written to `stderr`,
   * so a caller handles both failure modes in one place.
   *
   * **The caller owns the child's lifetime.** Drain both streams, or stop it with
   * {@link RuntimeRun.cancel}; a child nobody reads and nobody stops keeps
   * producing, and its output accumulates in the host's memory.
   */
  run(source: string, options?: RuntimeRunOptions): Promise<RuntimeRun>;
  /**
   * Run the static-analysis pass over `source` and its import graph without
   * instantiating anything. Never throws for a manifest that fails to load —
   * that is {@link RuntimeCheckResult.loadError}, which is an answer, not an
   * error.
   */
  check(source: string, options?: RuntimeCheckOptions): Promise<RuntimeCheckResult>;
}

export interface RuntimeRunOptions {
  /** Host environment the child binds its `variables:` / `secrets:` / `ports:`
   *  from. Omitted means the caller's own — a child never inherits more than it
   *  is handed. */
  env?: Record<string, string | undefined>;
}

/**
 * A started child manifest.
 *
 * Output is a stream rather than a captured string because the two useful
 * behaviours — forward it live, keep it to print on failure — are the caller's
 * to choose, and only one of them survives a value produced at the end. A caller
 * that just wants the text drains the stream itself.
 *
 * A stream does **not** by itself bound the host's memory: an unread stream still
 * accumulates whatever the child writes. What bounds it is {@link cancel} — stop
 * the child, rather than hoping it stops producing.
 */
export interface RuntimeRun {
  readonly stdout: Stream<string>;
  readonly stderr: Stream<string>;
  /** Settles when the child has finished — including after {@link cancel}. Both
   *  streams have ended by then. */
  readonly exitCode: Promise<number>;
  /**
   * Stop the child and tear it down.
   *
   * On the contract from the start rather than added later: termination is the
   * first thing a supervisor or a workflow engine running an open-ended
   * sub-manifest needs, and it is also the only bound on an unread child's
   * output. Idempotent, and safe after the child has already finished.
   *
   * Resolves when teardown has completed, so a caller that must know the child
   * released its resources — ports, connections, files — can await it.
   */
  cancel(reason?: string): Promise<void>;
}

export interface RuntimeCheckOptions {
  /** Expand each module document's inline `imports:` map into synthetic
   *  `Telo.Import` manifests before analysis, so a manifest using inline imports
   *  analyzes the way it runs. */
  desugarImports?: boolean;
}

/** Severity as a name rather than the LSP integer: the integer is a protocol
 *  detail of one editor transport, and this contract is read by a Rust or Go
 *  kernel too. */
export type CheckDiagnosticSeverity = "error" | "warning" | "info" | "hint";

/** A mechanically applicable repair for a finding: `replacement` is the whole
 *  corrected value at `path` — never a fragment — so a consumer applies it
 *  without parsing the language inside.
 *
 *  That is why `path` travels with it. `source` / `line` / `column` locate a
 *  finding for a human reading text; a module applying a repair works on the
 *  parsed manifest, where a line number is not an address. A repair without its
 *  anchor is one nothing can apply. */
export interface CheckDiagnosticFix {
  replacement: string;
}

/** One analyzer finding, flattened to data. Positions are zero-based, matching
 *  the analyzer's own range model. */
export interface CheckDiagnostic {
  code: string;
  message: string;
  severity: CheckDiagnosticSeverity;
  /** URL of the manifest the finding is in, when the analyzer located one. */
  source?: string;
  line?: number;
  column?: number;
  /** `<kind>/<name>` of the resource the finding is pinned to. */
  resource?: string;
  /** Dotted path of the offending value within that resource
   *  (`steps[0].inputs.flag`) — the address `fix` applies at. */
  path?: string;
  /** Present only when the repair is decidable — a fix that might not be
   *  correct is worse than none, since the point of the field is that it can be
   *  applied without review. */
  fix?: CheckDiagnosticFix;
}

export interface RuntimeCheckResult {
  diagnostics: CheckDiagnostic[];
  /** Set when the import graph could not be loaded at all, in which case
   *  `diagnostics` is empty — there was nothing to analyze. */
  loadError?: string;
}
