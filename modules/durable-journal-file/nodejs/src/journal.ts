/**
 * A durable journal over a directory of append-only files — one per run.
 *
 * **Append-only, and flushed per record.** The format is newline-delimited JSON,
 * which is not a stylistic choice: a durable journal's whole job is that
 * everything already finished survives an abrupt exit, and an append of one line
 * followed by an fsync is the smallest operation with that property. A format
 * that rewrote the file (a JSON array, a keyed object) would put every earlier
 * record at risk on every write — the opposite of what is wanted.
 *
 * **First writer wins, enforced on read-back rather than by locking.** Within a
 * run the file is append-only and records are keyed by step path, so a duplicate
 * append is resolved by taking the FIRST occurrence of a path when reading. Two
 * processes appending concurrently is not made safe by this — that is what the
 * claim is for, and a directory of files cannot make it safe anyway. Saying so
 * is better than a lock file that looks like a guarantee.
 */
import { appendFile, mkdir, open, readFile, readdir, truncate } from "node:fs/promises";
import { join } from "node:path";
import { InvokeError, type ResourceContext, type ResourceManifest } from "@telorun/sdk";

interface JournalManifest extends ResourceManifest {
  directory: string;
}

interface JournalEntry {
  path: string;
  kind: "step" | "decision";
  decision?: string;
  target?: { kind: string; name: string };
  value: unknown;
}

interface RunRecord {
  run: string;
  status: "running" | "completed" | "failed";
  result?: unknown;
  error?: { code: string; message: string };
}

/** A run id is a caller-chosen string (`onboard:ada@example.com`), and it becomes
 *  a file name. Encoded rather than sanitized: sanitizing is lossy, so two
 *  distinct run ids could collapse onto one file and silently share a journal —
 *  which is the worst outcome this store can produce. */
function fileFor(directory: string, run: string): string {
  return join(directory, `${encodeURIComponent(run)}.ndjson`);
}

function runOf(fileName: string): string {
  return decodeURIComponent(fileName.replace(/\.ndjson$/, ""));
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

  async admitRun(run: string): Promise<{ admitted: boolean; existing?: RunRecord }> {
    const file = fileFor(this.resource.directory, run);
    const header: RunRecord = { run, status: "running" };
    try {
      // `wx` is the whole admission: an exclusive create either wins or reports
      // that the run already exists. Checking existence and then writing would
      // be two operations with a window between them, and the window is exactly
      // where a concurrent duplicate start slips through.
      const handle = await open(file, "wx");
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

  async completeRun(run: string, outcome: Omit<RunRecord, "run">): Promise<void> {
    await this.appendLine(run, { type: "run", run, ...outcome });
    this.#claims.delete(run);
  }

  async interruptedRuns(limit: number): Promise<string[]> {
    await this.#ready;
    const out: string[] = [];
    for (const file of await readdir(this.resource.directory)) {
      if (!file.endsWith(".ndjson")) continue;
      const run = runOf(file);
      const record = await this.readRun(run);
      // Admitted and never settled: the run whose process died. A completed or
      // failed run has its terminal record, and one currently claimed is
      // someone's — a poller that took it may still be working through it.
      if (record?.status !== "running") continue;
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

  private async readRun(run: string): Promise<RunRecord | undefined> {
    const lines = await this.readLines(run);
    let record: RunRecord | undefined;
    // LAST run line wins, unlike an entry: the header is written at admission
    // and the terminal is appended at settlement, so the most recent one is the
    // run's current state. Entries are the opposite (first wins) because they
    // record facts that must never change once recorded.
    for (const line of lines) {
      if (line.type === "run") record = line as unknown as RunRecord;
    }
    return record;
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
