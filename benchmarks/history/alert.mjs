#!/usr/bin/env node
// Opens a GitHub issue when the newest benchmark run is a regression against the history kept by
// append.mjs. Usage: node alert.mjs --help

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HELP = `Usage: node benchmarks/history/alert.mjs --history <dir> [options]

Reads comparison.jsonl and feature-cost.jsonl from <dir> (the benchmark-results branch, checked
out or exported) and, for each figure below, compares the newest run with the 10 runs before it.
A figure alerts when the newest run is worse than the median of those 10 by more than its
threshold AND worse than every one of them. Fewer than 10 earlier runs means no alert.

  per workload  telo / node of the median CPU time per request    threshold 10%
  per workload  telo / node of the median p99 at the fixed rate   threshold 10%
  per feature   run time at the largest N every run in the window completed   threshold 15%
  per feature   check time at that N                                          threshold 15%
  per feature   firstFailure at a smaller N than in every run of the window   any move

An alert opens an issue labelled "benchmark-regression", or comments on the open one for the same
figure.

  --history <dir>   Directory holding the .jsonl files (required).
  --repo <owner/name>  Repository to raise issues in (default: $GITHUB_REPOSITORY).
  --subject <name>  The subject measured (default: telo).
  --baseline <name> The subject it is divided by (default: node).
  --dry-run         Print the alerts and call nothing.

$GITHUB_TOKEN authenticates the GitHub calls (the workflow needs permissions: issues: write).`;

export const WINDOW = 10;
export const LABEL = "benchmark-regression";
export const RATIO_THRESHOLD = 0.1;
export const FEATURE_THRESHOLD = 0.15;

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Reads a JSON-lines file; an absent file is no history, a malformed line is an error. */
export function readHistory(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, index) => ({ text, number: index + 1 }))
    .filter(({ text }) => text.trim() !== "")
    .map(({ text, number }) => {
      let value;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new Error(`${file} line ${number} is not JSON: ${error.message}`);
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${file} line ${number} is not a JSON object`);
      }
      return value;
    });
}

const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** A rise-is-worse series: the newest value against the WINDOW values before it. */
export function judgeRise(series, threshold) {
  if (series.length < WINDOW + 1) return null;
  const window = series.slice(-(WINDOW + 1));
  const newest = window[WINDOW];
  const previous = window.slice(0, WINDOW);
  const baseline = median(previous);
  if (newest > baseline * (1 + threshold) && newest > Math.max(...previous)) {
    return { newest, baseline, change: newest / baseline - 1 };
  }
  return null;
}

function ratioSeries(records, workload, metric, subject, baseline) {
  const series = [];
  for (const record of records) {
    const results = record.workloadResults ?? [];
    const pick = (name) => results.find((r) => r.workload === workload && r.subject === name)?.[metric]?.median;
    const top = pick(subject);
    const bottom = pick(baseline);
    if (positive(top) && positive(bottom)) series.push(top / bottom);
  }
  return series;
}

const METRICS = [
  { metric: "cpuPerRequestMs", name: "cpu-per-request", title: "CPU time per request" },
  { metric: "p99Ms", name: "p99", title: "p99 latency at the fixed rate" },
];

export function comparisonAlerts(records, { subject = "telo", baseline = "node" } = {}) {
  if (records.length === 0) return [];
  const workloads = [...new Set((records[records.length - 1].workloadResults ?? []).map((r) => r.workload))];
  const alerts = [];
  for (const workload of workloads) {
    for (const { metric, name, title } of METRICS) {
      const verdict = judgeRise(ratioSeries(records, workload, metric, subject, baseline), RATIO_THRESHOLD);
      if (!verdict) continue;
      alerts.push({
        key: `comparison/${workload}/${name}`,
        title: `Benchmark regression: ${workload} ${subject}/${baseline} ${title}`,
        detail:
          `The ${subject} / ${baseline} ratio of the median ${title.toLowerCase()} on the \`${workload}\` workload is ` +
          `${verdict.newest.toFixed(3)}, ${(verdict.change * 100).toFixed(1)}% above the median of the previous ${WINDOW} runs ` +
          `(${verdict.baseline.toFixed(3)}) and above every one of them (threshold ${RATIO_THRESHOLD * 100}%).`,
        record: records[records.length - 1],
      });
    }
  }
  return alerts;
}

const featureTimings = [
  { field: "runWarmMs", name: "run", title: "warm `telo run` time" },
  { field: "checkWarmMs", name: "check", title: "warm `telo check` time" },
];

export function featureCostAlerts(records) {
  const byFeature = new Map();
  for (const record of records) {
    if (typeof record.feature !== "string") throw new Error("a feature-cost record has no feature name");
    if (!byFeature.has(record.feature)) byFeature.set(record.feature, []);
    byFeature.get(record.feature).push(record);
  }
  const alerts = [];
  for (const [feature, runs] of byFeature) {
    if (runs.length < WINDOW + 1) continue;
    const window = runs.slice(-(WINDOW + 1));
    const newest = window[WINDOW];

    const completed = window.map((run) => new Set((run.sizes ?? []).map((s) => s.n)));
    const common = [...completed[0]].filter((n) => completed.every((set) => set.has(n)));
    if (common.length > 0) {
      const n = Math.max(...common);
      for (const { field, name, title } of featureTimings) {
        const series = window.map((run) => run.sizes.find((s) => s.n === n)?.[field]?.median);
        if (!series.every(positive)) continue;
        const verdict = judgeRise(series, FEATURE_THRESHOLD);
        if (!verdict) continue;
        alerts.push({
          key: `feature-cost/${feature}/${name}`,
          title: `Benchmark regression: ${feature} ${title}`,
          detail:
            `The median ${title} of \`${feature}\` at N = ${n} (the largest size every run in the window completed) is ` +
            `${verdict.newest.toFixed(1)} ms, ${(verdict.change * 100).toFixed(1)}% above the median of the previous ${WINDOW} runs ` +
            `(${verdict.baseline.toFixed(1)} ms) and above every one of them (threshold ${FEATURE_THRESHOLD * 100}%).`,
          record: newest,
        });
      }
    }

    const limitOf = (run) => run.firstFailure?.n ?? Infinity;
    const earlier = window.slice(0, WINDOW).map(limitOf);
    if (limitOf(newest) < Math.min(...earlier)) {
      alerts.push({
        key: `feature-cost/${feature}/limit`,
        title: `Benchmark regression: ${feature} stops at a smaller size`,
        detail:
          `\`${feature}\` first fails at N = ${newest.firstFailure.n} (${newest.firstFailure.code}), where the previous ${WINDOW} runs ` +
          `reached ${Math.min(...earlier) === Infinity ? "every size" : `at least N = ${Math.min(...earlier)}`}.`,
        record: newest,
      });
    }
  }
  return alerts;
}

const marker = (key) => `<!-- ${LABEL}: ${key} -->`;

function bodyOf(alert) {
  const { commit, teloVersion, host } = alert.record;
  const where = [commit && `commit ${commit}`, teloVersion && `telo ${teloVersion}`, host?.model && `host ${host.model}`]
    .filter(Boolean)
    .join(", ");
  return `${alert.detail}\n\n${where ? `Newest run: ${where}.\n\n` : ""}${marker(alert.key)}`;
}

/** Raises each alert through the client: a comment on the figure's open issue, else a new issue. */
export async function raiseAlerts(alerts, client) {
  const outcomes = [];
  for (const alert of alerts) {
    const body = bodyOf(alert);
    const open = await client.findOpen(marker(alert.key));
    if (open === null) {
      const number = await client.create({ title: alert.title, body, labels: [LABEL] });
      outcomes.push({ key: alert.key, action: "opened", number });
    } else {
      await client.comment(open, body);
      outcomes.push({ key: alert.key, action: "commented", number: open });
    }
  }
  return outcomes;
}

export function githubClient({ repo, token, fetchImpl = fetch }) {
  const api = async (method, path, payload) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${(await response.text()).trim()}`);
    }
    return response.json();
  };
  return {
    async findOpen(text) {
      for (let page = 1; ; page++) {
        const issues = await api("GET", `/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`);
        const found = issues.find((issue) => !issue.pull_request && typeof issue.body === "string" && issue.body.includes(text));
        if (found) return found.number;
        if (issues.length < 100) return null;
      }
    },
    async create(issue) {
      return (await api("POST", "/issues", issue)).number;
    },
    async comment(number, body) {
      await api("POST", `/issues/${number}/comments`, { body });
    },
  };
}

export async function run({ history, subject, baseline, client }) {
  const alerts = [
    ...comparisonAlerts(readHistory(join(history, "comparison.jsonl")), { subject, baseline }),
    ...featureCostAlerts(readHistory(join(history, "feature-cost.jsonl"))),
  ];
  return { alerts, outcomes: client ? await raiseAlerts(alerts, client) : [] };
}

async function main() {
  const { values: opts } = parseArgs({
    options: {
      history: { type: "string" },
      repo: { type: "string" },
      subject: { type: "string", default: "telo" },
      baseline: { type: "string", default: "node" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (!opts.history) throw new Error("--history is required");
  let client;
  if (!opts["dry-run"]) {
    const repo = opts.repo ?? process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("--repo or $GITHUB_REPOSITORY is required");
    if (!process.env.GITHUB_TOKEN) throw new Error("$GITHUB_TOKEN is required");
    client = githubClient({ repo, token: process.env.GITHUB_TOKEN });
  }
  const { alerts, outcomes } = await run({ history: opts.history, subject: opts.subject, baseline: opts.baseline, client });
  if (alerts.length === 0) console.log("alert: no regression");
  for (const alert of alerts) console.log(`alert: ${alert.key}: ${alert.detail}`);
  for (const outcome of outcomes) console.log(`alert: ${outcome.action} #${outcome.number} for ${outcome.key}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`alert: ${error.message}`);
    process.exit(1);
  });
}
