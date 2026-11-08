import type { ComparisonRecord, ThresholdBreach } from "./comparison-record.js";
import type { ComparisonSettings } from "./comparison-settings.js";
import { renderTextTable } from "./text-table.js";

const MIB = 1024 * 1024;

function trimLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;

/** The boot and workload tables with their footnotes, as printed on stdout. */
export function renderComparisonTables(
  record: ComparisonRecord,
  settings: ComparisonSettings,
  bold: (text: string) => string,
): string {
  const parts: string[] = [];
  // The two tables share their first two columns, so they read as one.
  const firstColumn = record.workloadResults.length > 0 ? ["Boot", "Workload"] : ["Boot"];
  const firstWidth = Math.max(...firstColumn.map((h) => h.length), ...record.workloadResults.map((r) => r.workload.length));
  const subjectWidth = Math.max("Subject".length, ...record.bootResults.map((b) => b.subject.length));
  const lead = (first: string, subject: string) => [first.padEnd(firstWidth), subject.padEnd(subjectWidth)];
  const bootRows = record.bootResults.map((b) => [
    ...lead("", b.subject),
    `${Math.round(b.coldMs.median)}ms`,
    `${Math.round(b.warmMs.median)}ms`,
    b.startupMs ? `${Math.round(b.startupMs.median)}ms` : "-",
  ]);
  parts.push(renderTextTable([...lead("Boot", "Subject"), "Cold", "Warm", "Startup span"], bootRows, bold, false));

  if (record.workloadResults.length > 0) {
    const concurrencies = new Set(settings.workloads.map((w) => w.concurrency));
    const uniform = concurrencies.size === 1 ? [...concurrencies][0] : undefined;
    const concurrencyOf = new Map(settings.workloads.map((w) => [w.name, w.concurrency]));
    const rows = record.workloadResults.map((r) => {
      const rps = `${r.throughput.median.toFixed(1)}${r.generatorBound ? "*" : ""}`;
      const rss = r.rssBytes
        ? `${Math.round(r.rssBytes.idle / MIB)}/${Math.round(r.rssBytes.peak / MIB)}/${Math.round(r.rssBytes.after / MIB)} MB`
        : "-";
      return [
        ...lead(r.workload, r.subject),
        uniform === undefined ? `${rps} (c=${concurrencyOf.get(r.workload)})` : rps,
        r.p50Ms ? `${r.p50Ms.median.toFixed(1)}ms` : "-",
        r.p99Ms ? `${r.p99Ms.median.toFixed(1)}ms` : "-",
        r.cpuPerRequestMs ? `${r.cpuPerRequestMs.median.toFixed(2)}ms` : "-",
        rss,
        percent(r.errors.rate),
      ];
    });
    const header = [
      ...lead("Workload", "Subject"),
      uniform === undefined ? "RPS" : `RPS (c=${uniform})`,
      "p50@rate",
      "p99@rate",
      "CPU/req",
      "RSS idle/peak/after",
      "Errors",
    ];
    parts.push(renderTextTable(header, rows, bold, false));
  }

  const notes: string[] = [];
  if (record.workloadResults.some((r) => r.generatorBound)) {
    notes.push("* generator-bound: the load generator saturated its cores; this throughput is a lower bound.");
  }
  const rated = settings.workloads.filter((w) => w.rate !== undefined);
  const rates = rated.length > 0 ? `Rates: ${rated.map((w) => `${w.name} ${w.rate}/s`).join(", ")}. ` : "";
  const rounds = `${settings.rounds} round${settings.rounds === 1 ? "" : "s"}`;
  const spreadNote = settings.reportFile ? "; spread is in the report file" : "";
  notes.push(
    `${rates}Generator on CPUs ${record.host.generatorCpus.join(",")}; subjects on CPUs ` +
      `${record.host.subjectCpus.join(",")}. Median of ${rounds}${spreadNote}.`,
  );
  return trimLines(`\n${parts.join("\n")}\n${notes.join("\n")}\n`);
}

/** The error groups of every workload result, or an empty string when nothing failed. */
export function renderErrorGroups(record: ComparisonRecord, bold: (text: string) => string): string {
  const rows: string[][] = [];
  for (const r of record.workloadResults) {
    for (const g of r.errors.groups) {
      rows.push(["", r.subject, r.workload, g.code, String(g.count), g.message, g.sample]);
    }
  }
  if (rows.length === 0) return "";
  const header = ["Errors", "Subject", "Workload", "Status", "Count", "Message", "Sample"];
  return trimLines(`\n${renderTextTable(header, rows, bold, false)}`);
}

export function renderBreach(b: ThresholdBreach): string {
  const value = (n: number) => (b.metric === "errorRate" ? percent(n) : `${n.toFixed(2)}ms`);
  return `THRESHOLD FAIL [${b.workload}/${b.subject}] ${b.metric} ${value(b.actual)} > ${value(b.limit)}`;
}
