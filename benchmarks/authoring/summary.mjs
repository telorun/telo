// The per-side report of a run's records: success rate, and the median over the attempts that
// passed of total tokens, cost and wall time. Results compare only within one model.

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const total = (tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

export function summarize(records) {
  const models = [...new Set(records.map((r) => r.model))];
  if (models.length > 1) throw new Error(`records of several models (${models.join(", ")}) are not comparable; summarize one model`);
  const groups = new Map();
  for (const record of records) {
    const key = `${record.task}\0${record.side}`;
    if (!groups.has(key)) groups.set(key, { task: record.task, side: record.side, records: [] });
    groups.get(key).records.push(record);
  }
  const rows = [...groups.values()].map(({ task, side, records: group }) => {
    const passing = group.filter((r) => r.contractTestsPassed);
    return {
      task,
      side,
      attempts: group.length,
      passed: passing.length,
      successRate: passing.length / group.length,
      medianTokens: median(passing.map((r) => total(r.tokens))),
      medianCostUsd: median(passing.filter((r) => r.costUsd !== null).map((r) => r.costUsd)),
      medianWallSeconds: median(passing.map((r) => r.wallSeconds)),
    };
  });
  return { model: models[0] ?? null, rows };
}

const cell = (value, format) => (value === null ? "-" : format(value));
const tokensText = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const minutes = (s) => `${(s / 60).toFixed(1)} min`;

// Side by side per task: the Telo side's tokens include the primer and hub context, which are part
// of what authoring in Telo costs.
export function renderSummary({ model, rows }) {
  const tasks = [...new Set(rows.map((r) => r.task))];
  const lines = [`Model: ${model ?? "-"}`, "", "| Task | Side | Passed | Success | Median tokens | Median cost | Median time |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const task of tasks) {
    for (const row of rows.filter((r) => r.task === task)) {
      lines.push(
        `| ${task} | ${row.side} | ${row.passed}/${row.attempts} | ${Math.round(row.successRate * 100)}% | ${cell(row.medianTokens, tokensText)} | ${cell(row.medianCostUsd, (v) => `$${v.toFixed(2)}`)} | ${cell(row.medianWallSeconds, minutes)} |`,
      );
    }
  }
  lines.push("", "Medians are over passing attempts. Tokens are input + output + cache reads + cache writes.");
  return lines.join("\n");
}
