/**
 * A durable journal over a directory of append-only files — one per run.
 *
 * **Append-only, and flushed per record.** The format is newline-delimited JSON,
 * which is not a stylistic choice: a durable journal's whole job is that
 * everything already finished survives an abrupt exit, and an append of one line
 * followed by an fsync is the smallest operation with that property. A format
 * that rewrote the file (a JSON array, a keyed object) would put every earlier
 * record at risk on every write — the opposite of what is wanted. The one
 * rewrite, a baseline replacing a long run's entries, stages a whole new file
 * and renames it into place, so no earlier record is ever at risk.
 *
 * **First writer wins, enforced on read-back rather than by locking.** Within a
 * run the file is append-only and records are keyed by step path, so a duplicate
 * append is resolved by taking the FIRST occurrence of a path when reading. Two
 * processes appending concurrently is not made safe by this — that is what the
 * claim is for, and a directory of files cannot make it safe anyway. Saying so
 * is better than a lock file that looks like a guarantee.
 */
import { access, appendFile, mkdir, open, readFile, readdir, rename, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import { InvokeError, type ResourceContext, type ResourceManifest } from "@telorun/sdk";

interface JournalManifest extends ResourceManifest {
  directory: string;
}

/**
 * One recorded fact, as this store holds it.
 *
 * `v` and `value` are DATA here and nothing else: the value arrives already
 * written down, under the codec version beside it, and this store's whole
 * obligation is that the two come back together and unchanged. That is what lets
 * the engine guarantee a recorded value replays with its CEL type without every
 * store implementing a codec — and it is why appending returns the caller's own
 * entry rather than a decoded one: there is nothing here to decode, so the first
 * pass and a replay read the identical record.
 *
 * `value` is absent when the step produced nothing, which is a fact about the
 * ENTRY — the step completed — rather than a value of its own.
 */
interface JournalEntry {
  path: string;
  kind: "step" | "decision" | "baseline";
  decision?: string;
  target?: { kind: string; name: string; module?: string };
  v?: number;
  value?: unknown;
}

interface ParkRecord {
  path: string;
  resource: string;
  at?: number;
  token?: string;
}

/**
 * The record as this store holds it.
 *
 * A structural restatement of the backend-neutral shape rather than an import of
 * it, because a journal is reachable by a kernel that never loaded the engine
 * module. It has to be kept true all the same: this store carries a settlement
 * by spreading it into a line and reads it back by casting, so a field missing
 * from here still ROUND-TRIPS — and is a lie to every reader of the type, which
 * is what would drop it silently the day this file projects columns explicitly
 * the way the SQL journals already do.
 */
interface RunRecord {
  run: string;
  status: "scheduled" | "running" | "parked" | "completed" | "failed" | "cancelled";
  dueAt?: number;
  parked?: ParkRecord;
  /** `inputs` / `result` with the codec version that wrote each — data this
   *  store keeps together and never reads, exactly like an entry's `v` and
   *  `value`. */
  inputs?: unknown;
  inputsCodecVersion?: number;
  result?: unknown;
  resultCodecVersion?: number;
  error?: { code: string; message: string };
  collapsedRegions?: number;
  collapseReasons?: string[];
  /** How many steps the execution that SETTLED this run was handed from the
   *  record rather than executing. Absent — never zero — for a run settled
   *  before it was recorded. */
  replayedSteps?: number;
  /** The workflow that admitted the run, and when it reached a terminal status. */
  workflow?: string;
  finishedAt?: number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** A run id is a caller-chosen string (`onboard:ada@example.com`), and it becomes
 *  a file name. Encoded rather than sanitized: sanitizing is lossy, so two
 *  distinct run ids could collapse onto one file and silently share a journal —
 *  which is the worst outcome this store can produce. */
function fileFor(directory: string, run: string): string {
  return join(directory, `${encodeURIComponent(run)}.ndjson`);
}

/** Where a compaction stages the run's next file before renaming it over it. */
function stagingFor(file: string): string {
  return `${file}.compacting`;
}

function runOf(fileName: string): string {
  return decodeURIComponent(fileName.replace(/\.ndjson$/, ""));
}

/**
 * The run's current state, from its lines.
 *
 * LAST run line wins, unlike an entry: the header is written at admission and
 * the terminal is appended at settlement, so the most recent one is the run's
 * current state. Entries are the opposite (first wins) because they record facts
 * that must never change once recorded.
 */
function recordOf(lines: { type?: string }[]): RunRecord | undefined {
  let record: RunRecord | undefined;
  for (const line of lines) {
    if (line.type === "run") record = line as unknown as RunRecord;
  }
  return record;
}

/** Has something already been recorded at this position? For a parked run that
 *  means its answer has arrived — see `dueRuns`. */
function hasEntryAt(lines: { type?: string }[], path: string | undefined): boolean {
  if (!path) return false;
  return lines.some(
    (line) => line.type === "entry" && (line as { entry?: { path?: string } }).entry?.path === path,
  );
}

/**
 * Is this run something a poller should pick up now?
 *
 * Four states with one answer, because they are one question. `running` is a run
 * whose process died — admitted and never settled. `parked` is due when its
 * deadline has passed, or when a delivery already cleared the park (which
 * `unparkRun` records as `running`, so it arrives here through the first case).
 * `scheduled` is due when its time has come. Everything terminal is not.
 */
function isDue(record: RunRecord, now: number, answered: () => boolean): boolean {
  if (record.status === "running") return true;
  if (record.status === "scheduled") return record.dueAt !== undefined && record.dueAt <= now;
  if (record.status === "parked") {
    // The answer already being recorded outranks the deadline. A delivery writes
    // the payload and then clears the park; a crash in between would otherwise
    // strand a run that holds its answer and has no deadline to wake it. The
    // entry is the fact that matters, so reading it is what makes the pair
    // recoverable without being atomic.
    if (answered()) return true;
    return record.dueAt !== undefined && record.dueAt <= now;
  }
  return false;
}

interface ClaimState {
  holder: string;
  until: number;
}

class FileJournalController {
  readonly #claims = new Map<string, ClaimState>();
  /** Runs whose torn tail this process has already dealt with. Repair is once
   *  per run per process: a file this process has appended to since is
   *  well-formed by construction, so re-reading it before every append would
   *  cost a whole-file read per record to answer a question that cannot change. */
  readonly #repaired = new Set<string>();
  #ready: Promise<void> | undefined;

  constructor(
    private readonly resource: JournalManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {
    // No I/O in init beyond making the directory exist: building the instance is
    // init's job, and the directory is what every other operation is relative
    // to, so creating it lazily would mean every method carrying the check.
    this.#ready = mkdir(this.resource.directory, { recursive: true }).then(() => undefined);
    await this.#ready;
  }

  async provide(): Promise<this> {
    return this;
  }

  async admitRun(
    run: string,
    init?: {
      status?: "running" | "scheduled";
      dueAt?: number;
      inputs?: unknown;
      inputsCodecVersion?: number;
      claim?: { holder: string; ttlMs: number };
      workflow?: string;
    },
  ): Promise<{ admitted: boolean; existing?: RunRecord }> {
    const file = fileFor(this.resource.directory, run);
    const header: RunRecord = {
      run,
      status: init?.status ?? "running",
      ...(init?.dueAt === undefined ? {} : { dueAt: init.dueAt }),
      ...(init?.inputs === undefined ? {} : { inputs: init.inputs }),
      ...(init?.inputsCodecVersion === undefined
        ? {}
        : { inputsCodecVersion: init.inputsCodecVersion }),
      ...(init?.workflow === undefined ? {} : { workflow: init.workflow }),
    };
    try {
      // `wx` is the whole admission: an exclusive create either wins or reports
      // that the run already exists. Checking existence and then writing would
      // be two operations with a window between them, and the window is exactly
      // where a concurrent duplicate start slips through.
      const handle = await open(file, "wx");
      // Claimed before the header is written: a sweep reads a file with no
      // header as no run at all, so the run is never visible unclaimed.
      if (init?.claim) {
        this.#claims.set(run, {
          holder: init.claim.holder,
          until: Date.now() + init.claim.ttlMs,
        });
      }
      try {
        await handle.writeFile(`${JSON.stringify({ type: "run", ...header })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { admitted: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return { admitted: false, existing: (await this.readRun(run)) ?? header };
    }
  }

  async readEntries(run: string): Promise<JournalEntry[]> {
    const lines = await this.readLines(run);
    const seen = new Set<string>();
    const entries: JournalEntry[] = [];
    for (const line of lines) {
      if (line.type !== "entry") continue;
      const entry = line as unknown as { entry: JournalEntry };
      // First occurrence wins, mirroring the append contract — so a file that
      // somehow holds two records at one path replays the same one every time
      // rather than depending on read order.
      if (seen.has(entry.entry.path)) continue;
      seen.add(entry.entry.path);
      entries.push(entry.entry);
    }
    return entries;
  }

  async append(run: string, entry: JournalEntry): Promise<JournalEntry> {
    // Read-back before write, so a path already recorded returns the stored
    // entry rather than adding a second. Within one process this is exact;
    // across processes it is not, which is what the claim exists to prevent
    // rather than something this store can fix.
    const existing = (await this.readEntries(run)).find((e) => e.path === entry.path);
    if (existing) return existing;
    await this.appendLine(run, { type: "entry", entry });
    return entry;
  }

  /**
   * Rewrite the run's file as its current record, every entry not replaced, and
   * the baseline — staged beside it and renamed over it, so a crash leaves the old
   * file or the new one and nothing between. A staging file a crash left behind
   * ends in `.compacting`, which no reader lists; the next compaction overwrites
   * it and a purge removes it.
   */
  async replaceWithBaseline(
    run: string,
    baseline: JournalEntry,
    replaced: readonly string[],
  ): Promise<void> {
    const lines = await this.readLines(run);
    const record = recordOf(lines);
    if (!record) {
      throw new InvokeError(
        "ERR_DURABLE_JOURNAL_CORRUPT",
        `Run '${run}': cannot write a baseline for a run this journal holds no record of.`,
        { run },
      );
    }
    const gone = new Set(replaced);
    const kept = new Set<string>();
    const out = [JSON.stringify(record)];
    for (const line of lines) {
      if (line.type !== "entry") continue;
      const path = (line as unknown as { entry: JournalEntry }).entry.path;
      // First occurrence only, so the rewrite keeps the entry readers already took.
      if (gone.has(path) || kept.has(path)) continue;
      kept.add(path);
      out.push(JSON.stringify(line));
    }
    out.push(JSON.stringify({ type: "entry", entry: baseline }));

    const file = fileFor(this.resource.directory, run);
    const staging = stagingFor(file);
    const handle = await open(staging, "w");
    try {
      await handle.writeFile(`${out.join("\n")}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, file);
    // The rename is durable only once the directory is: a machine losing power
    // before that could lose entries appended to the new file after it.
    await this.syncDirectory();
    this.#repaired.add(run);
  }

  async completeRun(run: string, outcome: Omit<RunRecord, "run">): Promise<void> {
    // The workflow is carried over from the header, since a settlement line
    // replaces the run's state wholesale and would otherwise drop it.
    const workflow = (await this.readRun(run))?.workflow;
    await this.appendLine(run, {
      type: "run",
      run,
      ...(workflow === undefined ? {} : { workflow }),
      ...outcome,
      finishedAt: Date.now(),
    });
    this.#claims.delete(run);
  }

  /**
   * Terminal runs of one workflow finished at or before the cutoff, oldest first.
   * A directory scan, like `dueRuns`, for the same reason: there is no index.
   */
  async finishedRuns(workflow: string, finishedBefore: number, limit: number): Promise<string[]> {
    await this.#ready;
    const found: { run: string; finishedAt: number }[] = [];
    for (const file of await readdir(this.resource.directory)) {
      if (!file.endsWith(".ndjson")) continue;
      const run = runOf(file);
      const record = await this.readRun(run);
      if (
        record?.workflow !== workflow ||
        !TERMINAL.has(record.status) ||
        record.finishedAt === undefined ||
        record.finishedAt > finishedBefore
      ) {
        continue;
      }
      found.push({ run, finishedAt: record.finishedAt });
    }
    return found
      .sort((a, b) => a.finishedAt - b.finishedAt)
      .slice(0, limit)
      .map((f) => f.run);
  }

  /**
   * Remove the run's file — record and entries are lines of the one file, so the
   * unlink is what makes the delete all-or-nothing. The condition is checked just
   * before it; as everywhere in this store, two processes racing on one run are
   * kept apart by the claim, not by the file system.
   */
  async deleteFinishedRun(run: string, finishedBefore: number): Promise<boolean> {
    const record = await this.readRun(run);
    if (
      !record ||
      !TERMINAL.has(record.status) ||
      record.finishedAt === undefined ||
      record.finishedAt > finishedBefore
    ) {
      return false;
    }
    const file = fileFor(this.resource.directory, run);
    // A concurrent purge of the same run got here first: already gone.
    try {
      await unlink(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      // Windows reports a file another unlink is deleting as EPERM; gone afterwards means it lost the race.
      if (code === "EPERM" && !(await access(file).then(() => true, () => false))) return false;
      throw err;
    }
    await unlink(stagingFor(file)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    this.#claims.delete(run);
    this.#repaired.delete(run);
    return true;
  }

  /**
   * Record a park.
   *
   * Written as a new `run` line rather than as an entry, because it is the run's
   * STATE and the last one wins — a park that is later woken must not leave two
   * records competing to describe where the run is.
   */
  async parkRun(run: string, park: ParkRecord): Promise<void> {
    const current = await this.readRun(run);
    await this.appendLine(run, {
      type: "run",
      ...(current ?? { run }),
      run,
      status: "parked",
      parked: park,
      ...(park.at === undefined ? {} : { dueAt: park.at }),
    });
    // The claim goes with the park: the run is no longer being worked on, and
    // holding it would make the parked run invisible to every poller — including
    // this process's own, after a delivery — until the TTL lapsed.
    this.#claims.delete(run);
  }

  async unparkRun(run: string): Promise<void> {
    const current = await this.readRun(run);
    if (!current) return;
    const { parked: _parked, dueAt: _dueAt, ...rest } = current;
    await this.appendLine(run, { type: "run", ...rest, run, status: "running" });
  }

  /**
   * The run parked on a token.
   *
   * A directory scan, and stated rather than hidden: a file journal has no index
   * to consult, so this is O(runs in the directory) per delivery. That is the
   * honest cost of this store, and it is exactly what a journal over a database
   * — where a token is a column with an index on it — exists to improve. A
   * deployment doing enough deliveries for this to matter has outgrown the
   * directory for other reasons first.
   */
  async runParkedOn(token: string): Promise<{ run: string; park: ParkRecord } | undefined> {
    await this.#ready;
    for (const file of await readdir(this.resource.directory)) {
      if (!file.endsWith(".ndjson")) continue;
      const run = runOf(file);
      const record = await this.readRun(run);
      if (record?.status !== "parked" || record.parked?.token !== token) continue;
      return { run, park: record.parked };
    }
    return undefined;
  }

  async dueRuns(now: number, limit: number): Promise<string[]> {
    await this.#ready;
    const out: string[] = [];
    for (const file of await readdir(this.resource.directory)) {
      if (!file.endsWith(".ndjson")) continue;
      const run = runOf(file);
      // ONE read answers both halves. The record and the entries are lines of
      // the same file, so asking whether a parked run's answer has already
      // arrived costs nothing beyond what reading its status already cost.
      const lines = await this.readLines(run);
      const record = recordOf(lines);
      if (!record || !isDue(record, now, () => hasEntryAt(lines, record.parked?.path))) continue;
      // A run someone is actively working is not due: a poller that took it may
      // still be moving through it, and taking it again would duplicate every
      // unrecorded effect in flight.
      const claim = this.#claims.get(run);
      if (claim && claim.until > Date.now()) continue;
      out.push(run);
      if (out.length >= limit) break;
    }
    return out;
  }

  async claimRun(run: string, holder: string, ttlMs: number): Promise<boolean> {
    const claim = this.#claims.get(run);
    if (claim && claim.until > Date.now() && claim.holder !== holder) return false;
    this.#claims.set(run, { holder, until: Date.now() + ttlMs });
    return true;
  }

  /**
   * Do this journal's writes land inside the given zone's atomicity?
   *
   * Always no, and stated rather than omitted. A directory of files shares
   * nothing with a database transaction, so an atomic region journaled per step
   * would record entries a rollback cannot erase — which is precisely the
   * inconsistency the collapse rule exists to avoid. Answering false is what
   * gets this store today's collapse, and it is correct.
   */
  writesInside(): boolean {
    return false;
  }

  snapshot(): Record<string, unknown> {
    return { directory: this.resource.directory };
  }

  async readRun(run: string): Promise<RunRecord | undefined> {
    return recordOf(await this.readLines(run));
  }

  /** Flush the directory's own entries — a rename is recorded there. Windows
   *  opens no directory for flushing, and commits a rename as part of it. */
  private async syncDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(this.resource.directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readLines(run: string): Promise<{ type?: string }[]> {
    await this.#ready;
    let text: string;
    try {
      text = await readFile(fileFor(this.resource.directory, run), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // Only the FINAL line may be incomplete, and only when the file does not end
    // in a newline — that is exactly what an abrupt exit mid-append leaves
    // behind. The record it would have been never completed, so the work it
    // described never completed either, and re-executing it is correct.
    // Anything earlier is corruption: replaying past it would skip work that may
    // have happened, which is the one failure this store must not produce
    // silently.
    const raw = text.split("\n");
    const complete = text.endsWith("\n") ? raw : raw.slice(0, -1);
    const out: { type?: string }[] = [];
    for (const line of complete) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch (err) {
        throw new InvokeError(
          "ERR_DURABLE_JOURNAL_CORRUPT",
          `Run '${run}': a record in the middle of the journal could not be read ` +
            `(${(err as Error).message}). Replaying past it would skip work that may ` +
            `have happened, so the run is not resumable from this file.`,
          { run },
          { cause: err },
        );
      }
    }
    return out;
  }

  /**
   * Drop an incomplete final record before writing after it.
   *
   * A process killed mid-append leaves a partial line with no terminating
   * newline. Appending onto that FUSES the two records into one unparseable
   * line — and the damage is far worse than the torn line was: a torn line is
   * the LAST line, which the reader discards as work that never completed, while
   * a fused one sits in the middle of the file, where discarding it would mean
   * skipping a record that may describe work that did happen. So the reader
   * refuses, and a journal that was perfectly resumable a moment ago is not.
   *
   * Truncating back to the last newline is the same verdict the reader already
   * reaches, applied once by the writer instead of on every read: the record
   * never finished being written, so the work it described never finished, and
   * it must run again. Doing it here is what keeps the two halves agreeing about
   * what the file MEANS.
   */
  private async repairTornTail(file: string): Promise<void> {
    // BYTES, not characters. `truncate` takes a byte offset, while an index into
    // a decoded string counts CODE UNITS — and these records carry `✓`, `…` and
    // `→`, each of which is one character and three bytes. Locating the last
    // newline in the decoded text and truncating to that index cuts short by one
    // byte per multi-byte character before it, which lands inside an EARLIER
    // record and tears a line that was intact. The repair then produces exactly
    // the damage it exists to prevent, one line further up.
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const NEWLINE = 0x0a;
    if (bytes.length === 0 || bytes[bytes.length - 1] === NEWLINE) return;
    await truncate(file, bytes.lastIndexOf(NEWLINE) + 1);
  }

  private async appendLine(run: string, line: unknown): Promise<void> {
    await this.#ready;
    const file = fileFor(this.resource.directory, run);
    if (!this.#repaired.has(run)) {
      await this.repairTornTail(file);
      this.#repaired.add(run);
    }
    // An append followed by nothing would leave the record in the OS page cache,
    // where a process that dies still has it and a machine that loses power does
    // not. Durability is the whole product here, so the flush is not optional.
    await appendFile(file, `${JSON.stringify(line)}\n`);
    const handle = await open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function register(): void {}

export async function create(
  resource: JournalManifest,
  ctx: ResourceContext,
): Promise<FileJournalController> {
  return new FileJournalController(resource, ctx);
}
