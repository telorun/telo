import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutosaveWrites } from "../src/browser/autosave-writes.js";
import { FormRecords } from "../src/browser/form-records.js";
import { Settling, type ChangeKind } from "../src/browser/typing-pause.js";

type Record_ = Record<string, unknown>;

type SettleStep = ({ change: ChangeKind } | { commit: true } | { elapse: number }) & { settled: number };
type FormStep = ({ settle: Record_ } | { start: string } | { unplace: true }) & { holds: Record_ | null; placed?: boolean };
type AutosaveStep = (
  | { change: Record_; how: ChangeKind }
  | { elapse: number }
  | { commit: true }
  | { hide: true }
  | { retry: true }
  | { discard: true }
  | { answer: "acknowledged" | "failed" }
  | { begin: true }
) & { sent?: Record_[]; state?: string; unsaved?: boolean };

type Row =
  | { name: string; kind: "settle"; pause: number; steps: SettleStep[] }
  | { name: string; kind: "form"; schema: Record_; steps: FormStep[] }
  | { name: string; kind: "autosave"; queued?: true; schema: Record_; start: Record_; debounce: number; steps: AutosaveStep[] };

/** `ui`'s conformance rows: the settle rule, what `form` holds, and when `autosave` sends. */
const { rows } = JSON.parse(readFileSync(new URL("../../../ui/conformance/form-writes.json", import.meta.url), "utf8")) as { rows: Row[] };

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

async function runAutosave(row: Extract<Row, { kind: "autosave" }>): Promise<void> {
  const pending: ((acknowledged: boolean) => void)[] = [];
  // A queued row's writes start at its `begin` steps; any other's as they are sent.
  const waiting: (() => Record_)[] = [];
  let sent: Record_[] = [];
  const writes = new AutosaveWrites(row.schema, row.start, row.debounce, {
    send: (take) => {
      if (row.queued) waiting.push(take);
      else sent.push(take());
      return new Promise((resolve) => pending.push(resolve));
    },
    changed: () => undefined,
  });
  for (const [index, step] of row.steps.entries()) {
    sent = [];
    if ("change" in step) writes.change(step.change, step.how);
    else if ("elapse" in step) await vi.advanceTimersByTimeAsync(step.elapse);
    else if ("commit" in step) writes.commit();
    else if ("hide" in step) writes.hidden();
    else if ("retry" in step) writes.retry();
    else if ("discard" in step) writes.discard();
    else if ("begin" in step) {
      const take = waiting.shift();
      if (!take) throw new Error(`step ${index} starts a write nothing sent`);
      sent.push(take());
    }
    else {
      const answer = pending.shift();
      if (!answer) throw new Error(`step ${index} answers a write nothing sent`);
      answer(step.answer === "acknowledged");
      await vi.advanceTimersByTimeAsync(0);
    }
    const seen: Record<string, unknown> = { sent };
    const expected: Record<string, unknown> = { sent: step.sent ?? [] };
    if (step.state !== undefined) [seen.state, expected.state] = [writes.state, step.state];
    if (step.unsaved !== undefined) [seen.unsaved, expected.unsaved] = [writes.unsaved, step.unsaved];
    expect(seen, `step ${index}`).toEqual(expected);
  }
}

describe("the form-writes conformance rows", () => {
  for (const row of rows) {
    it(row.name, async () => {
      if (row.kind === "settle") {
        let settled = 0;
        const settling = new Settling(() => void (settled += 1), row.pause);
        for (const [index, step] of row.steps.entries()) {
          if ("change" in step) settling.change(step.change);
          else if ("commit" in step) settling.now();
          else vi.advanceTimersByTime(step.elapse);
          expect(settled, `step ${index}`).toBe(step.settled);
        }
        return;
      }
      if (row.kind === "form") {
        const forms = new FormRecords();
        const unplace = forms.place("Test/form");
        for (const [index, step] of row.steps.entries()) {
          if ("settle" in step) forms.settle("Test/form", row.schema, step.settle);
          else if ("start" in step) forms.started("Test/form", step.start);
          else unplace();
          const root = forms.root("Test/form");
          expect({ holds: root.record ?? null, ...(step.placed === undefined ? {} : { placed: root.placed }) }, `step ${index}`).toEqual({
            holds: step.holds,
            ...(step.placed === undefined ? {} : { placed: step.placed }),
          });
        }
        return;
      }
      await runAutosave(row);
    });
  }
});
