import type { EngineFileClaim, EngineDiagnostic, TemplatingEngine } from "../engine.js";
import { INCLUDE_BYTES_ENGINE, INCLUDE_TEXT_ENGINE, makeTaggedSentinel } from "../sentinel.js";

/** Characters that would make a path a pattern rather than a name. Globs are
 *  excluded deliberately: a claim has to name one file for publish to place it
 *  in a layer, and a pattern that matches nothing on the publishing machine
 *  would ship an artifact missing a file the manifest reads. */
const GLOB_CHARS = /[*?[\]{}]/;

/** `scheme:` prefix — a URL, or a Windows drive letter. Either way not a
 *  module-relative path. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export interface NormalizedIncludePath {
  /** Module-root-relative path with `./` and `.` segments folded out, `/`
   *  separated. Absent when the source is not a usable path. */
  readonly path?: string;
  readonly diagnostic?: EngineDiagnostic;
}

/**
 * Normalize an `!include-*` source to a module-root-relative path, or explain
 * why it is not one.
 *
 * Pure string work, deliberately: this runs in the analyzer, which must load in
 * a browser, so confinement is decided from the written path alone and never by
 * asking a filesystem where it lands. That is possible because the path is
 * root-relative by definition — the module root is the one directory every path
 * is measured from, so `..` below depth zero is an escape regardless of where
 * the module happens to sit on disk.
 */
export function normalizeIncludePath(source: string): NormalizedIncludePath {
  const raw = source.trim();
  if (raw === "") {
    return {
      diagnostic: {
        code: "INCLUDE_PATH_INVALID",
        message: "the path is empty — name a file relative to the module root.",
      },
    };
  }
  if (URI_SCHEME.test(raw)) {
    return {
      diagnostic: {
        code: "INCLUDE_PATH_INVALID",
        message:
          `'${raw}' names a location outside the module. An include path is a file that ships ` +
          `inside the module artifact, written relative to the module root. To read a file at ` +
          `runtime from somewhere else, use Fs.File.`,
      },
    };
  }
  if (GLOB_CHARS.test(raw)) {
    return {
      diagnostic: {
        code: "INCLUDE_PATH_INVALID",
        message:
          `'${raw}' looks like a pattern. An include path names exactly one file, because ` +
          `publish places each claimed file into a layer by name.`,
      },
    };
  }
  if (raw.startsWith("/") || raw.startsWith("\\")) {
    return {
      diagnostic: {
        code: "INCLUDE_PATH_ESCAPES_MODULE",
        message:
          `'${raw}' is an absolute path. An include path is written relative to the module ` +
          `root, so the same manifest resolves identically from a checkout and from a ` +
          `published artifact.`,
      },
    };
  }

  const out: string[] = [];
  for (const segment of raw.split(/[/\\]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    // Depth zero is the module root. Popping past it would read a file the
    // artifact cannot contain, so it is an escape rather than a path to
    // normalize — and catching it here is what keeps the check static.
    if (out.length === 0) {
      return {
        diagnostic: {
          code: "INCLUDE_PATH_ESCAPES_MODULE",
          message:
            `'${raw}' points above the module root. An include path may only name a file ` +
            `inside the module, since that is the only thing its artifact can carry.`,
        },
      };
    }
    out.pop();
  }
  if (out.length === 0) {
    return {
      diagnostic: {
        code: "INCLUDE_PATH_INVALID",
        message: `'${raw}' resolves to the module root, not to a file.`,
      },
    };
  }
  return { path: out.join("/") };
}

/**
 * The `!include-text` / `!include-bytes` engines — a file that ships inside the
 * module artifact, embedded as a manifest value.
 *
 * `compile` returns the sentinel unchanged rather than a value. Two things
 * follow, and both are the point. The read is deferred to resource creation, so
 * loading a manifest does not pull payload layers — the artifact spec makes
 * `telo.yaml` its own layer precisely so that reading a manifest cannot drag the
 * whole artifact in, and an app loads every imported library's manifest. And
 * because the marker survives precompile the way a `!ref` does, the analyzer can
 * type the slot without opening the file, which is what keeps it browser-safe.
 * Unlike `!ref`, no special case is needed in `precompileDoc`: an engine whose
 * `compile` is identity on its own marker passes through the generic path.
 *
 * `analyze` reports why a path is unusable; `fileClaims` reports the path itself
 * so publish can place the file in a layer without recognising the tag by name.
 */
function includeEngine(name: string): TemplatingEngine {
  return {
    name,

    compile(source) {
      return makeTaggedSentinel(name, source);
    },

    analyze(source) {
      const { diagnostic } = normalizeIncludePath(source);
      return { diagnostics: diagnostic ? [diagnostic] : [], calls: [] };
    },

    fileClaims(source): readonly EngineFileClaim[] {
      const { path } = normalizeIncludePath(source);
      // A malformed path claims nothing. `analyze` is what says why, so
      // claiming a half-understood path here would produce a second, worse
      // report from publish about the same mistake.
      return path ? [{ path }] : [];
    },
  };
}

/** Embeds a file's contents as a UTF-8 string. */
export const includeTextEngine: TemplatingEngine = includeEngine(INCLUDE_TEXT_ENGINE);

/** Embeds a file's contents as raw bytes — a `Uint8Array`, the shape every
 *  `x-telo-binary` slot accepts. */
export const includeBytesEngine: TemplatingEngine = includeEngine(INCLUDE_BYTES_ENGINE);
