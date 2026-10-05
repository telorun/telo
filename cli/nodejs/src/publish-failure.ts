/**
 * Why one module was not published, as a code a program can act on. The set is
 * closed and stable: a consumer of `telo publish -o json` branches on it, and
 * anything no code names is `publish_failed` with the reason in `message`.
 */
export type PublishFailureCode =
  | "module_not_found"
  | "manifest_invalid"
  | "version_missing"
  | "requires_refuted"
  | "import_unpinned"
  | "import_pin_mismatch"
  | "import_unreachable"
  | "sibling_not_published"
  | "version_content_mismatch"
  | "registry_unavailable"
  | "publish_failed";

export interface PublishFailureReport {
  code: PublishFailureCode;
  message: string;
  /** What the code is about: `{ alias, ref }` for an import, `{ refs }` for
   *  unpublished siblings, `{ version, publishedIntegrity, builtIntegrity }` for
   *  a version republished with other content, `{ diagnostics }` for a manifest
   *  that does not pass analysis. */
  details?: Record<string, unknown>;
}

/** A refusal raised where its cause is known, so the code is decided there and
 *  not guessed from a message further up. */
export class PublishFailure extends Error {
  constructor(
    readonly code: PublishFailureCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PublishFailure";
  }
}

export function publishFailureReport(err: unknown): PublishFailureReport {
  if (err instanceof PublishFailure) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    };
  }
  return { code: "publish_failed", message: err instanceof Error ? err.message : String(err) };
}
