/**
 * `telo release stage` — fetch, extract, verify and pin the files a module's
 * `sources:` block declares.
 *
 * Fetching is the CLI's alone: the kernel reads what this put on disk and never
 * reaches an upstream. Plain staging only verifies against the pins in the
 * manifest; `--pin` is the one writer of those pins, through the analyzer's
 * byte-splice editor, so nothing else in `telo.yaml` moves — and nothing is
 * written until the edited text reads back with exactly the pins computed.
 */

import {
  applyTextEdits,
  isModuleKind,
  isPlainSafe,
  readModuleSources,
  renderFixReplacement,
  resolveSourceUrl,
  sourceUrlProblem,
  type ModuleSource,
  type SourceArchiveFormat,
  type SourceEntry,
  type SourcePin,
  type TextEdit,
} from "@telorun/analyzer";
import { checkStagedEntry, readTarGz, type BundleEntry } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMap, isPair, isScalar, parse, parseAllDocuments, type Document, type Pair } from "yaml";
import { crateInputsDigest } from "./crate-inputs.js";

export interface StageTarget {
  /** Workspace-relative module key, for messages. */
  readonly key: string;
  readonly dir: string;
  readonly manifestPath: string;
}

export interface StageOutcome {
  readonly module: string;
  readonly source: string;
  /** Module-relative path of the entry. */
  readonly path: string;
  readonly action: "verified" | "staged" | "linked" | "pinned";
}

export interface StageFailure {
  readonly module: string;
  readonly source?: string;
  readonly path?: string;
  readonly url?: string;
  readonly message: string;
}

export interface StageResult {
  readonly outcomes: StageOutcome[];
  readonly failures: StageFailure[];
}

/** Reads the archive at a URL, in the format its source declares, into its entries. */
export type ArchiveReader = (url: string, format: SourceArchiveFormat) => Promise<BundleEntry[]>;

const FETCH_TIMEOUT_MS = 5 * 60_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 10;

function fetchFailure(url: string, err: unknown, timeoutMs: number): Error {
  if ((err as { name?: unknown }).name === "TimeoutError") {
    return new Error(`could not fetch the archive ${url}: no complete response within ${timeoutMs / 1000}s`);
  }
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  return new Error(`could not fetch the archive ${url}: ${detail}`);
}

/**
 * One fetch per URL for the life of the reader; the caller decides that life
 * (the command takes one reader per module, so decoded archives do not pile up
 * across a workspace). A request is bounded in time, in response size and in
 * decompressed size, and may not end at a URL a source could not name.
 */
export function createArchiveReader(
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    maxExtractedBytes?: number;
  } = {},
): ArchiveReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const maxExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
  const cache = new Map<string, Promise<BundleEntry[]>>();
  return (url, format) => {
    const key = `${format}\0${url}`;
    let entries = cache.get(key);
    if (!entries) {
      entries = (async () => {
        const bytes = await fetchArchive(url, fetchImpl, timeoutMs, maxBytes);
        try {
          return await readTarGz(bytes, { maxBytes: maxExtractedBytes });
        } catch (err) {
          throw new Error(
            `the archive ${url} does not read as ${format}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      cache.set(key, entries);
    }
    return entries;
  };
}

async function fetchArchive(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer> {
  const tooLarge = () => new Error(`the archive ${url} is larger than the ${maxBytes}-byte limit`);
  const signal = AbortSignal.timeout(timeoutMs);
  // Redirects are followed here rather than by fetch, so each location is vetted
  // before any request goes to it: a redirect may not take the request somewhere
  // the manifest could not have named — a plain-http location above all.
  let response: Response;
  let current = url;
  for (let hops = 0; ; hops++) {
    try {
      response = await fetchImpl(current, { signal, redirect: "manual" });
    } catch (err) {
      throw fetchFailure(url, err, timeoutMs);
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) break;
    await response.body?.cancel();
    if (hops === MAX_REDIRECTS) {
      throw new Error(`the archive request ${url} was redirected more than ${MAX_REDIRECTS} times`);
    }
    const next = new URL(location, current).href;
    const refusal = sourceUrlProblem(next);
    if (refusal) {
      throw new Error(`the archive request ${url} was redirected to ${next}: ${refusal.detail}`);
    }
    current = next;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`the archive request ${url} answered ${response.status} ${response.statusText}`);
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`the archive request ${url} answered with no body`);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw fetchFailure(url, err, timeoutMs);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks);
}

interface ModuleDoc {
  readonly doc: Document;
  readonly text: string;
  readonly sources: ModuleSource[];
}

function readModuleDoc(
  target: StageTarget,
  failures: StageFailure[],
  pin: boolean,
): ModuleDoc | undefined {
  const text = fs.readFileSync(target.manifestPath, "utf8");
  for (const doc of parseAllDocuments(text, { customTags: defaultCustomTags() })) {
    if (doc.errors.length > 0) {
      failures.push({ module: target.key, message: `${target.manifestPath}: ${doc.errors[0]!.message}` });
      return undefined;
    }
    const json = doc.toJSON() as { kind?: unknown } | null;
    if (typeof json?.kind !== "string" || !isModuleKind(json.kind)) continue;
    // `--pin` replaces every pin, so a malformed one is not a reason to refuse.
    const { sources, problems } = readModuleSources(json, { ignorePins: pin });
    for (const problem of problems) {
      failures.push({
        module: target.key,
        message: `${problem.message} (at ${problem.path}; run \`telo check\` for every problem)`,
      });
    }
    return problems.length > 0 ? undefined : { doc, text, sources };
  }
  return undefined;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const memberName = (name: string): string => name.replace(/^(\.\/)+/, "");

async function extractMember(
  archives: ArchiveReader,
  source: ModuleSource,
  url: string,
  member: string,
): Promise<{ content: Buffer; executable: boolean }> {
  const entries = await archives(url, source.archive);
  const matches = entries.filter((entry) => memberName(entry.name) === memberName(member));
  if (matches.length > 1) {
    throw new Error(`member '${member}' occurs ${matches.length} times in the archive, so which file it names is ambiguous`);
  }
  const found = matches[0];
  if (!found) throw new Error(`member '${member}' is not in the archive`);
  if ("link" in found) {
    throw new Error(`member '${member}' is a symbolic link in the archive, not a file`);
  }
  const content = typeof found.content === "string" ? Buffer.from(found.content) : Buffer.from(found.content);
  return { content, executable: found.executable === true };
}

/**
 * Refuse an entry whose parent path crosses a symbolic link or a non-directory
 * on disk: the path is confined as text, but a checked-out link would carry
 * every rm, mkdir, write and symlink below it outside the module.
 */
function assertConfined(dir: string, entryPath: string): void {
  const segments = entryPath.split("/").slice(0, -1);
  let current = dir;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `'${path.relative(dir, current)}' is a symbolic link on disk; staging below it would write outside the module. Replace it with a directory.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`'${path.relative(dir, current)}' exists on disk and is not a directory.`);
    }
  }
}

function writeStaged(abs: string, content: Buffer, executable: boolean): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Removed first, so a link left at the path is replaced rather than written through.
  fs.rmSync(abs, { force: true });
  fs.writeFileSync(abs, content);
  fs.chmodSync(abs, executable ? 0o755 : 0o644);
}

async function stageSources(
  target: StageTarget,
  sources: readonly ModuleSource[],
  archives: ArchiveReader,
): Promise<StageResult> {
  const outcomes: StageOutcome[] = [];
  const failures: StageFailure[] = [];
  const failed = new Set<string>();
  const fail = (source: ModuleSource, entry: SourceEntry, message: string, url?: string) => {
    failed.add(`${source.name}\0${entry.path}`);
    failures.push({ module: target.key, source: source.name, path: entry.path, url, message });
  };

  for (const source of sources) {
    const record = (entry: SourceEntry, action: StageOutcome["action"]) =>
      outcomes.push({ module: target.key, source: source.name, path: entry.path, action });

    for (const entry of source.entries) {
      if (entry.kind !== "file") continue;
      const url = resolveSourceUrl(source, entry.upstream);
      if (!entry.pin) {
        fail(source, entry, "the entry is not pinned — run `telo release stage --pin` to write its sha256 and executable", url);
        continue;
      }
      const abs = path.join(target.dir, entry.path);
      try {
        assertConfined(target.dir, entry.path);
        // The same check the kernel applies before reading a staged file.
        if ((await checkStagedEntry(target.dir, source, entry)).state === "match") {
          record(entry, "verified");
          continue;
        }
        const { content, executable } = await extractMember(archives, source, url, entry.member);
        const digest = sha256Hex(content);
        if (digest !== entry.pin.sha256) {
          fail(source, entry, `member '${entry.member}' hashes to sha256 ${digest}, but the pin is ${entry.pin.sha256}`, url);
          continue;
        }
        if (executable !== entry.pin.executable) {
          fail(
            source,
            entry,
            `member '${entry.member}' is ${executable ? "" : "not "}executable, but the pin says executable: ${entry.pin.executable}`,
            url,
          );
          continue;
        }
        writeStaged(abs, content, executable);
        record(entry, "staged");
      } catch (err) {
        fail(source, entry, err instanceof Error ? err.message : String(err), url);
      }
    }

    for (const entry of source.entries) {
      if (entry.kind !== "link") continue;
      const abs = path.join(target.dir, entry.path);
      try {
        assertConfined(target.dir, entry.path);
        const existing = fs.lstatSync(abs, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink() && fs.readlinkSync(abs) === entry.target) {
          record(entry, "verified");
          continue;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (existing) fs.rmSync(abs, { force: true });
        fs.symlinkSync(entry.target, abs);
        record(entry, "linked");
      } catch (err) {
        fail(source, entry, err instanceof Error ? err.message : String(err));
      }
    }

    for (const entry of source.entries) {
      if (failed.has(`${source.name}\0${entry.path}`)) continue;
      const abs = path.join(target.dir, entry.path);
      let present: boolean;
      try {
        present =
          entry.kind === "file"
            ? fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile() === true
            : fs.existsSync(abs);
      } catch (err) {
        fail(source, entry, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!present) {
        fail(
          source,
          entry,
          entry.kind === "file"
            ? "the file is absent after staging"
            : `the link's target '${entry.target}' is absent after staging`,
        );
      }
    }
  }
  return { outcomes, failures };
}

/** A scalar field to set: a string (a digest) or a boolean. */
interface FieldValue {
  readonly key: string;
  readonly value: string | boolean;
}

/** YAML for a field value. A string is written in the quoting the replaced value
 *  used, and plain only when it reads back as that string — a digest of digits
 *  alone reads as a number unquoted. */
function renderValue(value: string | boolean, original: string | undefined): string {
  if (typeof value === "boolean") return String(value);
  if (original !== undefined && /^["']/.test(original)) {
    const rendered = renderFixReplacement(original, value);
    if (rendered !== undefined) return rendered;
  }
  return isPlainSafe(value) && typeof parse(value) === "string" ? value : JSON.stringify(value);
}

/**
 * Byte-splice edits setting `fields` on one mapping and touching nothing else: a
 * key already present has its value replaced in place (an empty one gains a
 * value), a missing key is added after the mapping's last entry, in the
 * mapping's own style and line ending.
 */
function setMappingFields(
  text: string,
  node: unknown,
  at: string,
  fields: readonly FieldValue[],
): TextEdit[] {
  if (!isMap(node) || !node.range) throw new Error(`${at}: expected a mapping with a source range`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits: TextEdit[] = [];
  const inserts: FieldValue[] = [];
  for (const field of fields) {
    const pair = node.items.find(
      (item): item is Pair => isPair(item) && isScalar(item.key) && item.key.value === field.key,
    );
    if (!pair) {
      inserts.push(field);
      continue;
    }
    edits.push(replaceValue(text, pair, `${at}.${field.key}`, field.value));
  }
  if (inserts.length === 0) return edits;

  const ends = node.items.map((item) => (isPair(item) ? pairEnd(text, item) : undefined));
  if (ends.some((end) => end === undefined)) {
    throw new Error(`${at}: expected scalar entries with source ranges; write the entry as plain key: value lines`);
  }
  const lastEnd = ends.length === 0 ? undefined : Math.max(...(ends as number[]));
  const rendered = inserts.map((field) => `${field.key}: ${renderValue(field.value, undefined)}`);

  if (node.flow) {
    // After the last entry rather than before the closing brace, which a
    // trailing comma would leave doubled.
    const start = lastEnd ?? text.indexOf("{", node.range[0]) + 1;
    const lead = lastEnd === undefined ? "" : ", ";
    edits.push({ start, end: start, newText: `${lead}${rendered.join(", ")}` });
    return edits;
  }

  const first = node.items[0];
  const firstKey = first && isScalar(first.key) ? first.key.range : undefined;
  if (!firstKey || lastEnd === undefined) throw new Error(`${at}: expected scalar entries with source ranges`);
  const indent = firstKey[0] - (text.lastIndexOf("\n", firstKey[0] - 1) + 1);
  const lineEnd = text.indexOf("\n", lastEnd);
  const lines = rendered.map((line) => `${" ".repeat(indent)}${line}${eol}`).join("");
  edits.push(
    lineEnd < 0
      ? { start: text.length, end: text.length, newText: `${eol}${lines}` }
      : { start: lineEnd + 1, end: lineEnd + 1, newText: lines },
  );
  return edits;
}

/** Where one scalar pair ends in the text: its value, or the colon of an empty one. */
function pairEnd(text: string, pair: Pair): number | undefined {
  const keyEnd = isScalar(pair.key) ? pair.key.range?.[1] : undefined;
  if (pair.value === null || (isScalar(pair.value) && pair.value.source === "")) {
    const colon = keyEnd === undefined ? -1 : text.indexOf(":", keyEnd);
    return colon < 0 ? undefined : colon + 1;
  }
  return isScalar(pair.value) ? pair.value.range?.[1] : undefined;
}

/** The edit replacing one pair's value; an empty value is written after its colon. */
function replaceValue(text: string, pair: Pair, at: string, value: string | boolean): TextEdit {
  const keyEnd = isScalar(pair.key) ? pair.key.range?.[1] : undefined;
  if (pair.value === null || (isScalar(pair.value) && pair.value.source === "")) {
    const colon = keyEnd === undefined ? -1 : text.indexOf(":", keyEnd);
    if (colon < 0) throw new Error(`${at}: expected a key with a source range`);
    const start = text[colon + 1] === " " ? colon + 2 : colon + 1;
    return { start, end: start, newText: `${start === colon + 1 ? " " : ""}${renderValue(value, undefined)}` };
  }
  const range = isScalar(pair.value) ? pair.value.range : undefined;
  if (!range) throw new Error(`${at}: expected a scalar with a source range`);
  const original = text.slice(range[0], range[1]);
  if (/[\n\r]/.test(original)) {
    throw new Error(`${at}: the existing value spans several lines and cannot be rewritten in place; write it on one line`);
  }
  return { start: range[0], end: range[1], newText: renderValue(value, original) };
}

interface PinnedEntry {
  readonly source: ModuleSource;
  readonly entry: SourceEntry;
  readonly pin: SourcePin;
}

/**
 * Why `text` does not carry exactly the pins and inputs computed, or undefined
 * when it does — read with the same reader everything downstream uses, so an
 * edit that produced invalid YAML, or YAML meaning something else, is never
 * written.
 */
function pinsReadBackProblem(
  text: string,
  pins: readonly PinnedEntry[],
  inputs: ReadonlyMap<string, string>,
): string | undefined {
  const docs = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const broken = docs.find((doc) => doc.errors.length > 0);
  if (broken) return `the edited manifest does not parse: ${broken.errors[0]!.message}`;
  const owner = docs
    .map((doc) => doc.toJSON() as { kind?: unknown } | null)
    .find((json) => typeof json?.kind === "string" && isModuleKind(json.kind));
  const { sources, problems } = readModuleSources(owner);
  if (problems.length > 0) {
    return `the edited sources: block does not read: ${problems.map((problem) => problem.message).join("; ")}`;
  }
  for (const { source, entry, pin } of pins) {
    const read = sources
      .find((candidate) => candidate.name === source.name)
      ?.entries.find((candidate) => candidate.key === entry.key);
    if (read?.kind !== "file" || read.pin?.sha256 !== pin.sha256 || read.pin.executable !== pin.executable) {
      return `source '${source.name}' entry '${entry.key}' does not read back with the pin written`;
    }
  }
  for (const [name, digest] of inputs) {
    if (sources.find((candidate) => candidate.name === name)?.build?.inputs !== digest) {
      return `source '${name}' does not read back with the build inputs written`;
    }
  }
  return undefined;
}

/** Replace a file's contents in one step, keeping its mode: a crash or a full
 *  disk leaves the old manifest, never half of the new one. */
function replaceFile(file: string, text: string): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, text, { mode: fs.statSync(file).mode & 0o777 });
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Stage one module's `sources:`. With `pin`, fetch every file entry, write its
 * `sha256` and `executable` — and each built source's `build.inputs` — into the
 * manifest, then stage against those pins. A module with no `sources:` block
 * yields an empty result.
 */
export async function stageModule(
  target: StageTarget,
  options: { pin: boolean; archives: ArchiveReader },
): Promise<StageResult> {
  const failures: StageFailure[] = [];
  const moduleDoc = readModuleDoc(target, failures, options.pin);
  if (!moduleDoc) return { outcomes: [], failures };
  if (!options.pin) return stageSources(target, moduleDoc.sources, options.archives);

  const pins: PinnedEntry[] = [];
  for (const source of moduleDoc.sources) {
    for (const entry of source.entries) {
      if (entry.kind !== "file") continue;
      const url = resolveSourceUrl(source, entry.upstream);
      try {
        const { content, executable } = await extractMember(options.archives, source, url, entry.member);
        pins.push({ source, entry, pin: { sha256: sha256Hex(content), executable } });
      } catch (err) {
        failures.push({
          module: target.key,
          source: source.name,
          path: entry.path,
          url,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // A built source records what built its files beside their pins, so a later
  // edit to that crate or a path dependency is caught by `release check`.
  const inputs = new Map<string, string>();
  for (const source of moduleDoc.sources) {
    if (source.build === undefined) continue;
    try {
      inputs.set(source.name, await crateInputsDigest(path.resolve(target.dir, source.build.cargo)));
    } catch (err) {
      failures.push({
        module: target.key,
        source: source.name,
        message: `cannot digest crate '${source.build.cargo}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // All or nothing: a manifest carrying some new pins and some stale ones would
  // verify against a mix no single upstream state produced.
  if (failures.length > 0) return { outcomes: [], failures };

  const { doc, text } = moduleDoc;
  let updated: string;
  try {
    const edits = [
      ...pins.flatMap(({ source, entry, pin }) =>
        setMappingFields(
          text,
          doc.getIn(["sources", source.name, "entries", entry.key], true),
          `sources.${source.name}.entries.${entry.key}`,
          [
            { key: "sha256", value: pin.sha256 },
            { key: "executable", value: pin.executable },
          ],
        ),
      ),
      ...[...inputs].flatMap(([name, digest]) =>
        setMappingFields(text, doc.getIn(["sources", name, "build"], true), `sources.${name}.build`, [
          { key: "inputs", value: digest },
        ]),
      ),
    ];
    updated = applyTextEdits(text, edits);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failures.push({ module: target.key, message: `cannot write pins into ${target.manifestPath}: ${detail}` });
    return { outcomes: [], failures };
  }
  const readBack = pinsReadBackProblem(updated, pins, inputs);
  if (readBack) {
    failures.push({
      module: target.key,
      message:
        `cannot write pins into ${target.manifestPath}: ${readBack}. The manifest was left ` +
        `unchanged — write the entry as plain \`key: value\` lines and run \`telo release stage --pin\` again.`,
    });
    return { outcomes: [], failures };
  }
  if (updated !== text) replaceFile(target.manifestPath, updated);
  const outcomes: StageOutcome[] = pins.map(({ source, entry }) => ({
    module: target.key,
    source: source.name,
    path: entry.path,
    action: "pinned",
  }));
  const staged = await stageModule(target, { pin: false, archives: options.archives });
  return { outcomes: [...outcomes, ...staged.outcomes], failures: staged.failures };
}
