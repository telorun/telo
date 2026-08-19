import { Static, Type } from "@sinclair/typebox";
import { ResourceContext } from "@telorun/sdk";
import { deepEquals } from "./deep-equals.js";

const FilterEntry = Type.Object({
  type: Type.String(),
});

const ExpectEntry = Type.Object({
  event: Type.String(),
  payload: Type.Optional(Type.Record(Type.String(), Type.Any())),
  times: Type.Optional(Type.Integer({ minimum: 0 })),
});

const schema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
  }),
  filter: Type.Optional(Type.Array(FilterEntry)),
  expect: Type.Array(ExpectEntry),
});

type AssertManifest = Static<typeof schema>;

type CapturedEvent = {
  name: string;
  payload?: any;
};

type ExpectEntry = Static<typeof ExpectEntry>;

type MatchResult =
  | { status: "matched"; entry: ExpectEntry; actual: CapturedEvent }
  | { status: "payload-mismatch"; entry: ExpectEntry; actual: CapturedEvent }
  | { status: "not-found"; entry: ExpectEntry }
  | { status: "counted"; entry: ExpectEntry; count: number }
  | { status: "count-mismatch"; entry: ExpectEntry; count: number };

function matchesPattern(pattern: string, eventName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventName) return true;
  if (!pattern.includes("*")) return false;
  const patternParts = pattern.split(".");
  const eventParts = eventName.split(".");
  if (patternParts.length !== eventParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] !== "*" && patternParts[i] !== eventParts[i]) return false;
  }
  return true;
}

/** Subset match: only the keys `expected` names are compared, recursively.
 *  Leaves go through `deepEquals` rather than `!==` so a CEL integer — an
 *  int64, i.e. a BigInt — matches the plain number YAML gives an `expected:`
 *  literal, which is the same reason `Assert.Equals` compares that way. With
 *  `!==` the two rendered identically in a failure report and compared
 *  unequal, so any integer-valued expression in an event payload was
 *  unassertable. */
function matchesPayload(actual: any, expected: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (actual == null) return false;
    if (typeof value === "object" && value !== null) {
      if (!matchesPayload(actual[key], value)) return false;
    } else {
      if (!deepEquals(actual[key], value)) return false;
    }
  }
  return true;
}

export async function create(manifest: AssertManifest, ctx: ResourceContext) {
  const useColor = (ctx.stderr as any).isTTY ?? false;
  const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = (t: string) => c("1", t);
  const red = (t: string) => c("31", t);
  const green = (t: string) => c("32", t);
  const yellow = (t: string) => c("33", t);
  const dim = (t: string) => c("2", t);

  /**
   * An entry with `times:` asserts HOW MANY, over the whole captured stream;
   * an entry without it asserts THAT ONE OCCURRED, at or after the position the
   * previous ordered entry reached.
   *
   * The two are different questions and only one of them has an answer that
   * depends on position. Counting is why: the ordered walk consumes the stream
   * as it goes, so a count taken from wherever it happened to stop would depend
   * on which other entries were written beside it — the same manifest reporting
   * a different number because an unrelated expectation moved. So a counted
   * entry reads the whole capture and does not advance the ordered position,
   * which also lets the two be mixed in one `expect:` list without either
   * changing what the other means.
   *
   * `times: 0` is the negative assertion, and it falls out rather than being a
   * second feature: it is the one thing the ordered form structurally cannot
   * express, because "not found" is its failure rather than its success.
   */
  function buildReport(name: string, captured: CapturedEvent[], expect: ExpectEntry[]) {
    const results: MatchResult[] = [];
    let pos = 0;

    for (const entry of expect) {
      if (entry.times !== undefined) {
        const count = captured.filter(
          (ev) =>
            matchesPattern(entry.event, ev.name) &&
            (!entry.payload || matchesPayload(ev.payload, entry.payload)),
        ).length;
        results.push({
          status: count === entry.times ? "counted" : "count-mismatch",
          entry,
          count,
        });
        continue;
      }

      let found = false;
      while (pos < captured.length) {
        const ev = captured[pos++];
        if (matchesPattern(entry.event, ev.name)) {
          if (!entry.payload || matchesPayload(ev.payload, entry.payload)) {
            results.push({ status: "matched", entry, actual: ev });
          } else {
            results.push({ status: "payload-mismatch", entry, actual: ev });
          }
          found = true;
          break;
        }
      }
      if (!found) {
        results.push({ status: "not-found", entry });
      }
    }

    const failures = results.filter((r) => r.status !== "matched" && r.status !== "counted");

    let report =
      bold(
        failures.length > 0
          ? red(`Assert.Events.${name}: assertion failed`)
          : green(`Assert.Events.${name}: assertion passed`),
      ) + "\n";
    for (const result of results) {
      if (result.status === "matched") {
        report += `  ${green("✓")} ${dim(result.actual.name)}\n`;
      } else if (result.status === "not-found") {
        report += `  ${red("✗")} ${result.entry.event}  ${dim("← not found in stream")}\n`;
        if (result.entry.payload) {
          report += `       ${dim("expected payload:")} ${yellow(JSON.stringify(result.entry.payload))}\n`;
        }
      } else if (result.status === "payload-mismatch") {
        report += `  ${red("✗")} ${result.actual.name}\n`;
        report += `       ${dim("expected payload:")} ${yellow(JSON.stringify(result.entry.payload))}\n`;
        report += `       ${dim("actual payload:  ")} ${red(JSON.stringify(result.actual.payload))}\n`;
      } else if (result.status === "counted") {
        report += `  ${green("✓")} ${dim(`${result.entry.event} ×${result.count}`)}\n`;
      } else if (result.status === "count-mismatch") {
        report += `  ${red("✗")} ${result.entry.event}  ${dim("← wrong number of occurrences")}\n`;
        report += `       ${dim("expected:")} ${yellow(`×${result.entry.times}`)}  ${dim("actual:")} ${red(`×${result.count}`)}\n`;
        if (result.entry.payload) {
          report += `       ${dim("matching payload:")} ${yellow(JSON.stringify(result.entry.payload))}\n`;
        }
      }
    }

    return { report, passed: failures.length === 0 };
  }

  const captured: CapturedEvent[] = [];
  const filters = manifest.filter ?? [{ type: "*" }];

  ctx.on("*", (event) => {
    if (filters.some((f) => matchesPattern(f.type, event.name))) {
      captured.push({ name: event.name, payload: event.payload });
    }
  });

  return {
    run: async () => {
      const report = buildReport(manifest.metadata.name, captured, manifest.expect);
      if (report) {
        if (report.passed) {
          ctx.stdout.write(report.report);
        } else {
          ctx.stderr.write(report.report);
          ctx.requestExit(1);
        }
      }
    },
  };
}
