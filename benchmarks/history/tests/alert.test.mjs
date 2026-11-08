import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { githubClient, run } from "../alert.mjs";

const spread = (median) => ({ median, min: median, max: median, cv: 0 });

function comparisonRun(index, { teloCpu = 1, teloP99 = 10 } = {}) {
  const result = (subject, cpu, p99) => ({
    workload: "leads",
    subject,
    cpuPerRequestMs: spread(cpu),
    p99Ms: spread(p99),
  });
  return {
    commit: `c${index}`,
    teloVersion: "0.1.0",
    host: { model: "test cpu" },
    workloadResults: [result("telo", teloCpu * (1 + (index % 3) / 100), teloP99), result("node", 0.5, 5)],
  };
}

function featureRun(index, { limit, sizes = [1, 2, 4, 8] } = {}) {
  return {
    commit: `c${index}`,
    feature: "forEachIterations",
    sizes: sizes.map((n) => ({ n, runWarmMs: spread(100 + n), checkWarmMs: spread(50 + n) })),
    ...(limit ? { firstFailure: { n: limit, code: "ERR_BENCHMARK_BOOT_FAILED", message: "hung" } } : {}),
  };
}

function history(files) {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-alert-"));
  for (const [name, records] of Object.entries(files)) {
    writeFileSync(join(directory, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return directory;
}

function fakeClient() {
  const issues = [];
  return {
    issues,
    async findOpen(text) {
      return issues.find((i) => i.body.includes(text))?.number ?? null;
    },
    async create(issue) {
      issues.push({ ...issue, number: issues.length + 1, comments: [] });
      return issues.length;
    },
    async comment(number, body) {
      issues.find((i) => i.number === number).comments.push(body);
    },
  };
}

const check = async (files, client = fakeClient()) => {
  const directory = history(files);
  try {
    return { client, ...(await run({ history: directory, subject: "telo", baseline: "node", client })) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const steady = (count) => Array.from({ length: count }, (_, i) => comparisonRun(i));

test("a 15% CPU-per-request regression opens one issue, and a repeat comments on it", async () => {
  const records = [...steady(10), comparisonRun(10, { teloCpu: 1.15 })];
  const first = await check({ "comparison.jsonl": records });
  assert.equal(first.client.issues.length, 1);
  assert.deepEqual(first.client.issues[0].labels, ["benchmark-regression"]);
  assert.match(first.client.issues[0].title, /leads telo\/node CPU time per request/);

  const second = await check({ "comparison.jsonl": records }, first.client);
  assert.equal(second.client.issues.length, 1);
  assert.equal(second.client.issues[0].comments.length, 1);
  assert.deepEqual(second.outcomes, [{ key: "comparison/leads/cpu-per-request", action: "commented", number: 1 }]);
});

test("a feature whose limit rises from 8 to 16 opens nothing", async () => {
  const records = [
    ...Array.from({ length: 10 }, (_, i) => featureRun(i, { limit: 8, sizes: [1, 2, 4] })),
    featureRun(10, { limit: 16, sizes: [1, 2, 4, 8] }),
  ];
  const result = await check({ "feature-cost.jsonl": records });
  assert.equal(result.client.issues.length, 0);
});

test("a feature whose limit falls from 16 to 8 opens an issue", async () => {
  const records = [
    ...Array.from({ length: 10 }, (_, i) => featureRun(i, { limit: 16, sizes: [1, 2, 4, 8] })),
    featureRun(10, { limit: 8, sizes: [1, 2, 4] }),
  ];
  const result = await check({ "feature-cost.jsonl": records });
  assert.deepEqual(result.alerts.map((a) => a.key), ["feature-cost/forEachIterations/limit"]);
});

test("fewer than 10 earlier runs opens nothing", async () => {
  const result = await check({ "comparison.jsonl": [...steady(9), comparisonRun(9, { teloCpu: 2 })] });
  assert.equal(result.client.issues.length, 0);
});

test("a malformed history line fails with its file and line", async () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-alert-"));
  try {
    writeFileSync(join(directory, "comparison.jsonl"), `${JSON.stringify(comparisonRun(0))}\n{oops\n`);
    await assert.rejects(run({ history: directory, subject: "telo", baseline: "node" }), /comparison\.jsonl line 2 is not JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed GitHub call fails with the status and the answer", async () => {
  const client = githubClient({
    repo: "o/r",
    token: "t",
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => "forbidden" }),
  });
  await assert.rejects(client.findOpen("x"), /GitHub GET .* failed \(403\): forbidden/);
});
