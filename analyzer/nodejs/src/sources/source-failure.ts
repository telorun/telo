/** Why a manifest source could not hand over a module, from one closed set. A
 *  source names the kind; the import-failure step words it, so every transport
 *  reports a failure in the same sentence whatever its own error said. */
export type SourceFailureKind = "not-found" | "not-a-module" | "unreadable" | "refused" | "unreachable";

/**
 * The failure a `ManifestSource` throws when it cannot read what it was asked
 * for. `location` is the canonical URL it was asked for (`file://`, `oci://`,
 * `https://`), never an OS path; `status` is the HTTP status a `refused` reply
 * carried. The transport's own error is kept as `cause` and nowhere else. An
 * integrity or pin mismatch is not a source failure.
 */
export class ManifestSourceFailure extends Error {
  readonly sourceFailure: SourceFailureKind;
  readonly location: string;
  readonly status?: number;

  constructor(
    sourceFailure: SourceFailureKind,
    location: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(
      sourceFailureSentence({ sourceFailure, location, status: options.status }),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ManifestSourceFailure";
    this.sourceFailure = sourceFailure;
    this.location = location;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** The sentence a source failure is reported with, after
 *  `Cannot resolve import '<alias>' → '<source>': `. */
export function sourceFailureSentence(failure: {
  sourceFailure: SourceFailureKind;
  location: string;
  status?: number;
}): string {
  const loc = failure.location;
  switch (failure.sourceFailure) {
    case "not-found":
      return `nothing exists at ${loc}.`;
    case "not-a-module":
      return `${loc} is not a module: it holds no telo.yaml.`;
    case "unreadable":
      return `${loc} exists but cannot be read.`;
    case "refused":
      return `the host refused the request for ${loc} (HTTP ${failure.status ?? "error"}).`;
    case "unreachable":
      return `${loc} cannot be reached: no connection to its host could be made.`;
  }
}

/** The source failure `error` is, read off its `sourceFailure` member — a value
 *  crossing a package boundary may come from another copy of this module. */
export function sourceFailureOf(error: unknown): ManifestSourceFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const kind = (error as { sourceFailure?: unknown }).sourceFailure;
  const location = (error as { location?: unknown }).location;
  return isSourceFailureKind(kind) && typeof location === "string"
    ? (error as ManifestSourceFailure)
    : undefined;
}

function isSourceFailureKind(value: unknown): value is SourceFailureKind {
  return (
    value === "not-found" ||
    value === "not-a-module" ||
    value === "unreadable" ||
    value === "refused" ||
    value === "unreachable"
  );
}

/** A filesystem read's failure, by the errno code the host reported: a path
 *  that does not exist (or runs through a file) is `not-found`, anything else
 *  `unreadable`. Browser-safe: the caller supplies the error and the URL. */
export function fileSourceFailure(error: unknown, location: string): ManifestSourceFailure {
  const code = (error as { code?: unknown } | undefined)?.code;
  return new ManifestSourceFailure(
    code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "unreadable",
    location,
    { cause: error },
  );
}

/** A request answered with a non-2xx status: `not-found` for 404, else
 *  `refused`, carrying the status. */
export function httpSourceFailure(status: number, location: string, cause?: unknown): ManifestSourceFailure {
  return status === 404
    ? new ManifestSourceFailure("not-found", location, { cause })
    : new ManifestSourceFailure("refused", location, { status, cause });
}
