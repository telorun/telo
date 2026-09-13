/**
 * A module's **sources** — the `sources:` block on a `Telo.Library` or
 * `Telo.Application` doc, saying where every staged file comes from: a pinned
 * upstream archive, fetched by `telo release stage`.
 *
 * ```yaml
 * sources:
 *   better-sqlite3:
 *     version: 12.8.0
 *     url: https://github.com/WiseLibs/better-sqlite3/releases/download/v{version}/better-sqlite3-v{version}-{upstream}.tar.gz
 *     archive: tar.gz
 *     notices: [./notices/better-sqlite3.LICENSE]
 *     entries:
 *       ./native/linux-amd64-gnu-node-137/better_sqlite3.node:
 *         upstream: node-v137-linux-x64
 *         member: build/Release/better_sqlite3.node
 *         sha256: 4c9e…
 *         executable: false
 *       ./native/linux-amd64-gnu/libvips.so:
 *         target: libvips.so.42
 * ```
 *
 * Keyed by the module-relative path an entry produces, because the manifest
 * already names every staged file — a `native:` entry's path or a
 * platform-qualified controller candidate's `path=`.
 *
 * The single reader: every rule decidable from the block alone is a problem
 * here, so `telo check` (`validate-source-entries.ts`), the stager and the
 * kernels refuse the same blocks. Browser-safe: string work only.
 */

import { normalizeNativePath } from "./native-entries.js";

const SOURCE_NAME_TOKEN = /^[a-z0-9][a-z0-9_.-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const INPUTS_DIGEST = /^sha256-[A-Za-z0-9_-]{43}$/;
const SOURCE_KEYS = ["version", "url", "archive", "notices", "entries", "build"];
const BUILD_KEYS = ["cargo", "inputs"];
const URL_PLACEHOLDERS = new Set(["version", "upstream"]);
const FILE_KEYS = ["upstream", "member", "sha256", "executable"] as const;
const URL_ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const LOOPBACK_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i;

/** The archive formats an upstream may be. */
export const SOURCE_ARCHIVE_FORMATS = ["tar.gz"] as const;
export type SourceArchiveFormat = (typeof SOURCE_ARCHIVE_FORMATS)[number];

export interface SourcePin {
  /** Lowercase hex digest of the file's bytes. */
  readonly sha256: string;
  readonly executable: boolean;
}

interface SourceEntryBase {
  /** The key as written, for diagnostic paths. */
  readonly key: string;
  /** Module-root-relative POSIX path, normalized. */
  readonly path: string;
}

export type SourceEntry =
  | (SourceEntryBase & {
      readonly kind: "file";
      readonly upstream: string;
      /** Path of the file inside the archive. */
      readonly member: string;
      /** Absent until `telo release stage --pin` writes it. */
      readonly pin?: SourcePin;
    })
  | (SourceEntryBase & {
      readonly kind: "link";
      /** The link target, exactly as the link stores it. */
      readonly target: string;
      /** The module-relative path the target resolves to. */
      readonly resolved: string;
    });

/** How a source's files are built in this repository, keyed by build system. */
export interface SourceBuild {
  /** Module-root-relative directory of the Cargo crate the files are built
   *  from, normalized (`""` for the module root). */
  readonly cargo: string;
  /** Digest of that crate's build inputs, `sha256-<base64url>`; absent until
   *  `telo release stage --pin` records it. */
  readonly inputs?: string;
}

export interface ModuleSource {
  readonly name: string;
  readonly version: string;
  /** The URL template, as written. */
  readonly url: string;
  readonly archive: SourceArchiveFormat;
  /** Module-root-relative notice paths, normalized. */
  readonly notices: readonly string[];
  readonly entries: readonly SourceEntry[];
  readonly build?: SourceBuild;
}

/**
 * Why part of the block could not be read.
 *
 * `SHAPE` is a missing, mistyped or unknown key the owner doc's JSON Schema
 * reports in the same pass; every other code is a rule `telo check` reports.
 */
export type SourceProblemCode =
  | "SHAPE"
  | "SOURCE_INVALID"
  | "SOURCE_URL_PLACEHOLDER_UNKNOWN"
  | "SOURCE_URL_INSECURE"
  | "SOURCE_ENTRY_INVALID"
  | "SOURCE_LINK_TARGET_UNRESOLVED"
  | "SOURCE_LINK_CYCLE"
  | "SOURCE_ENTRY_DUPLICATE"
  | "SOURCE_ENTRY_NESTED";

export interface SourceProblem {
  readonly code: SourceProblemCode;
  /** Dotted path from the module doc root, for `data.path`. */
  readonly path: string;
  readonly message: string;
}

export interface ModuleSources {
  readonly sources: ModuleSource[];
  readonly problems: SourceProblem[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The URL an entry is fetched from: substitution only. */
export function resolveSourceUrl(source: ModuleSource, upstream: string): string {
  return source.url.replaceAll("{version}", source.version).replaceAll("{upstream}", upstream);
}

/** Resolve a link target against the link's own directory, confined to the module. */
function resolveLinkTarget(linkPath: string, target: string): string | undefined {
  const dir = linkPath.includes("/") ? linkPath.slice(0, linkPath.lastIndexOf("/")) : "";
  if (target.startsWith("/") || target.startsWith("\\")) return undefined;
  const verdict = normalizeNativePath(dir === "" ? target : `${dir}/${target}`);
  return "path" in verdict ? verdict.path : undefined;
}

/** Why a url — a template, or the URL a fetch ended at after redirects — may not
 *  be fetched from, or undefined when it may: https, or plain http to a loopback
 *  host. */
export function sourceUrlProblem(url: string): { code: SourceProblemCode; detail: string } | undefined {
  const origin = URL_ORIGIN.exec(url);
  if (!origin) {
    return {
      code: "SOURCE_INVALID",
      detail: `url '${url}' is not an absolute URL. Write an https:// URL template.`,
    };
  }
  const scheme = origin[1]!.toLowerCase();
  if (scheme === "https") return undefined;
  const authority = origin[2]!;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostPort.startsWith("[")
    ? hostPort.slice(0, hostPort.indexOf("]") + 1)
    : hostPort.split(":")[0]!;
  if (scheme === "http" && LOOPBACK_HOST.test(host)) return undefined;
  return {
    code: "SOURCE_URL_INSECURE",
    detail:
      `url '${url}' is fetched over ${scheme}, where the archive could be altered on the way. ` +
      `Use https; plain http is accepted only for a loopback host (localhost, 127.0.0.0/8, [::1]).`,
  };
}

/** Whether one normalized module-relative path is a directory the other runs through. */
function runsThrough(path: string, parent: string): boolean {
  return path.startsWith(`${parent}/`);
}

/**
 * Read the `sources:` block off an owner document's JSON projection.
 *
 * A source or entry with any problem is left out, never read partially: a
 * half-read entry would stage a file the author did not declare.
 *
 * `ignorePins` reads a file entry's `sha256` / `executable` and a build's
 * `inputs` as absent — for the one writer of pins, which replaces them whatever
 * they held.
 */
export function readModuleSources(
  ownerJson: unknown,
  options: { ignorePins?: boolean } = {},
): ModuleSources {
  const ignorePins = options.ignorePins === true;
  const declared = (ownerJson as { sources?: unknown } | null)?.sources;
  const sources: ModuleSource[] = [];
  const problems: SourceProblem[] = [];
  if (declared === undefined) return { sources, problems };
  const problem = (code: SourceProblemCode, path: string, message: string) =>
    problems.push({ code, path, message });
  if (!isObject(declared)) {
    problem("SHAPE", "sources", "sources: expected a map of source name to source.");
    return { sources, problems };
  }

  const producers = new Map<string, { source: string; key: string }>();
  for (const [name, raw] of Object.entries(declared)) {
    const at = `sources.${name}`;
    const label = `source '${name}'`;
    if (!isObject(raw)) {
      problem("SHAPE", at, `${label}: expected an object.`);
      continue;
    }
    const build = raw.build;
    if (
      typeof raw.version !== "string" ||
      typeof raw.url !== "string" ||
      !(SOURCE_ARCHIVE_FORMATS as readonly unknown[]).includes(raw.archive) ||
      !Array.isArray(raw.notices) ||
      raw.notices.length === 0 ||
      raw.notices.some((notice) => typeof notice !== "string") ||
      !isObject(raw.entries) ||
      (build !== undefined &&
        (!isObject(build) ||
          typeof build.cargo !== "string" ||
          (!ignorePins && "inputs" in build && typeof build.inputs !== "string") ||
          Object.keys(build).some((key) => !BUILD_KEYS.includes(key)))) ||
      Object.keys(raw).some((key) => !SOURCE_KEYS.includes(key))
    ) {
      problem(
        "SHAPE",
        at,
        `${label}: a source is { version, url, archive (${SOURCE_ARCHIVE_FORMATS.join(" | ")}), ` +
          `notices (non-empty list), entries, build? { cargo, inputs? } } and nothing else.`,
      );
      continue;
    }

    let valid = true;
    if (!SOURCE_NAME_TOKEN.test(name)) {
      problem(
        "SOURCE_INVALID",
        `${at}`,
        `${label}: the name is not a canonical token. Use lowercase letters, digits, '.', '-' or ` +
          `'_', starting with a letter or digit.`,
      );
      valid = false;
    }
    for (const key of ["version", "url"] as const) {
      if ((raw[key] as string).trim() === "") {
        problem("SOURCE_INVALID", `${at}.${key}`, `${label}: '${key}' must not be empty.`);
        valid = false;
      }
    }
    const url = raw.url as string;
    for (const match of url.matchAll(/\{([^{}]*)\}/g)) {
      if (URL_PLACEHOLDERS.has(match[1]!)) continue;
      problem(
        "SOURCE_URL_PLACEHOLDER_UNKNOWN",
        `${at}.url`,
        `${label}: the url placeholder '{${match[1]}}' is not recognized. A url template may use ` +
          `only {version} (the source's version) and {upstream} (each entry's upstream).`,
      );
      valid = false;
    }
    const insecure = url.trim() === "" ? undefined : sourceUrlProblem(url);
    if (insecure) {
      problem(insecure.code, `${at}.url`, `${label}: ${insecure.detail}`);
      valid = false;
    }
    const notices: string[] = [];
    (raw.notices as string[]).forEach((notice, index) => {
      const verdict = normalizeNativePath(notice.trim());
      if ("path" in verdict) {
        notices.push(verdict.path);
        return;
      }
      problem("SOURCE_INVALID", `${at}.notices[${index}]`, `${label}: notice ${verdict.detail}`);
      valid = false;
    });

    let readBuild: SourceBuild | undefined;
    if (isObject(build)) {
      const written = (build.cargo as string).trim();
      const verdict = /^\.?\/?$/.test(written) ? { path: "" } : normalizeNativePath(written);
      const inputs = ignorePins ? undefined : (build.inputs as string | undefined);
      if (!("path" in verdict)) {
        problem(
          "SOURCE_INVALID",
          `${at}.build.cargo`,
          verdict.kind === "escape"
            ? `${label}: build.cargo '${written}' is not a directory inside the module. Name the ` +
                `crate relative to the directory holding telo.yaml; code outside the module reaches ` +
                `its digest as a path dependency of that crate.`
            : `${label}: build.cargo '${written}' does not name one module-relative directory.`,
        );
        valid = false;
      } else if (inputs !== undefined && !INPUTS_DIGEST.test(inputs)) {
        problem(
          "SOURCE_INVALID",
          `${at}.build.inputs`,
          `${label}: build.inputs must be a digest of the form sha256-<43 base64url characters> — ` +
            `run \`telo release stage --pin\` to write it.`,
        );
        valid = false;
      } else {
        readBuild = { cargo: verdict.path, ...(inputs !== undefined ? { inputs } : {}) };
      }
    }

    const entries: SourceEntry[] = [];
    const rawEntries = raw.entries as Record<string, unknown>;
    const entryPaths = new Map<string, string>();
    const links: Array<{ key: string; path: string; target: string }> = [];
    // Paths first, from every key, so a link to an entry with an unrelated
    // problem is not also reported as unresolved.
    const pathOfKey = new Map<string, string>();
    for (const key of Object.keys(rawEntries)) {
      const entryAt = `${at}.entries.${key}`;
      const verdict = normalizeNativePath(key.trim());
      if (!("path" in verdict)) {
        problem("SOURCE_ENTRY_INVALID", entryAt, `${label} entry '${key}': ${verdict.detail}`);
        valid = false;
        continue;
      }
      if (entryPaths.has(verdict.path)) {
        problem(
          "SOURCE_ENTRY_DUPLICATE",
          entryAt,
          `${label} entry '${key}': path '${verdict.path}' is also produced by entry ` +
            `'${entryPaths.get(verdict.path)}'.`,
        );
        valid = false;
        continue;
      }
      entryPaths.set(verdict.path, key);
      pathOfKey.set(key, verdict.path);
    }
    for (const [key, value] of Object.entries(rawEntries)) {
      const entryAt = `${at}.entries.${key}`;
      const entryLabel = `${label} entry '${key}'`;
      const path = pathOfKey.get(key);
      if (path === undefined) continue;
      if (!isObject(value)) {
        problem("SHAPE", entryAt, `${entryLabel}: expected an object.`);
        valid = false;
        continue;
      }
      const fileKeys = FILE_KEYS.filter((k) => k in value);
      const isLink = "target" in value;
      if (isLink && fileKeys.length > 0) {
        problem(
          "SOURCE_ENTRY_INVALID",
          entryAt,
          `${entryLabel}: an entry is either a link (target) or a file (upstream, member, ` +
            `sha256, executable) — remove ${fileKeys.map((k) => `'${k}'`).join(", ")} or 'target'.`,
        );
        valid = false;
        continue;
      }
      const strings = isLink ? ["target"] : ["upstream", "member"];
      if (
        strings.some((k) => typeof value[k] !== "string") ||
        (!ignorePins && "sha256" in value && typeof value.sha256 !== "string") ||
        (!ignorePins && "executable" in value && typeof value.executable !== "boolean")
      ) {
        problem("SHAPE", entryAt, `${entryLabel}: expected a file or a link entry.`);
        valid = false;
        continue;
      }
      const blank = strings.filter((k) => (value[k] as string).trim() === "");
      if (blank.length > 0) {
        for (const k of blank) {
          problem("SOURCE_ENTRY_INVALID", `${entryAt}.${k}`, `${entryLabel}: '${k}' must not be empty.`);
        }
        valid = false;
        continue;
      }
      if (isLink) {
        links.push({ key, path, target: value.target as string });
        continue;
      }
      const sha256 = ignorePins ? undefined : (value.sha256 as string | undefined);
      const executable = ignorePins ? undefined : (value.executable as boolean | undefined);
      if (sha256 !== undefined && !SHA256_HEX.test(sha256)) {
        problem(
          "SOURCE_ENTRY_INVALID",
          `${entryAt}.sha256`,
          `${entryLabel}: sha256 must be 64 lowercase hex characters — run ` +
            `\`telo release stage --pin\` to write it.`,
        );
        valid = false;
        continue;
      }
      if ((sha256 === undefined) !== (executable === undefined)) {
        problem(
          "SOURCE_ENTRY_INVALID",
          entryAt,
          `${entryLabel}: a pin is sha256 and executable together — run ` +
            `\`telo release stage --pin\` to write both.`,
        );
        valid = false;
        continue;
      }
      entries.push({
        kind: "file",
        key,
        path,
        upstream: value.upstream as string,
        member: value.member as string,
        ...(sha256 !== undefined ? { pin: { sha256, executable: executable! } } : {}),
      });
    }

    const linkTargets = new Map<string, string>();
    for (const link of links) {
      const resolved = resolveLinkTarget(link.path, link.target);
      const targetAt = `${at}.entries.${link.key}.target`;
      if (resolved === link.path) {
        problem(
          "SOURCE_LINK_CYCLE",
          targetAt,
          `${label} entry '${link.key}': link target '${link.target}' resolves to the link itself.`,
        );
        valid = false;
        continue;
      }
      if (resolved === undefined || !entryPaths.has(resolved)) {
        problem(
          "SOURCE_LINK_TARGET_UNRESOLVED",
          targetAt,
          `${label} entry '${link.key}': link target '${link.target}' resolves, relative to the ` +
            `link's directory, to ${resolved === undefined ? "a path outside the module" : `'${resolved}'`}, ` +
            `which is not another entry of this source.`,
        );
        valid = false;
        continue;
      }
      linkTargets.set(link.path, resolved);
      entries.push({ kind: "link", key: link.key, path: link.path, target: link.target, resolved });
    }
    for (const link of links) {
      if (!linkTargets.has(link.path)) continue;
      const chain = [link.path];
      for (let next = linkTargets.get(link.path); next !== undefined; next = linkTargets.get(next)) {
        if (!chain.includes(next)) {
          chain.push(next);
          continue;
        }
        problem(
          "SOURCE_LINK_CYCLE",
          `${at}.entries.${link.key}.target`,
          `${label} entry '${link.key}': the link never reaches a file — it cycles through ` +
            `${chain.map((p) => `'${p}'`).join(" → ")} → '${next}'. A link chain must end at a file entry.`,
        );
        valid = false;
        break;
      }
    }

    for (const entry of entries) {
      const other = producers.get(entry.path);
      if (other !== undefined) {
        problem(
          "SOURCE_ENTRY_DUPLICATE",
          `${at}.entries.${entry.key}`,
          `${label} entry '${entry.key}': path '${entry.path}' is also produced by source ` +
            `'${other.source}'. Each staged file has exactly one source.`,
        );
        valid = false;
        continue;
      }
      for (const [path, producer] of producers) {
        const relation = runsThrough(entry.path, path)
          ? `runs through '${path}' as a directory`
          : runsThrough(path, entry.path)
            ? `is a directory that '${path}' runs through`
            : undefined;
        if (relation === undefined) continue;
        problem(
          "SOURCE_ENTRY_NESTED",
          `${at}.entries.${entry.key}`,
          `${label} entry '${entry.key}': path '${entry.path}' ${relation}, and source ` +
            `'${producer.source}' entry '${producer.key}' produces '${path}'. A staged path cannot ` +
            `be both a file and a directory — give each entry its own path.`,
        );
        valid = false;
        break;
      }
      producers.set(entry.path, { source: name, key: entry.key });
    }

    if (!valid) continue;
    sources.push({
      name,
      version: raw.version as string,
      url,
      archive: raw.archive as SourceArchiveFormat,
      notices,
      entries,
      ...(readBuild !== undefined ? { build: readBuild } : {}),
    });
  }
  return { sources, problems };
}
