// Drops the CodeQL results a `codeql[<rule id>] <reason>` comment suppresses, from the SARIF files of one analysis run.
// A comment sits on the line directly above the flagged line (`//` in JS/TS/Rust, `#` in YAML) and names exactly one rule.
// The job fails on a comment with no reason, a comment naming several rules or a wildcard, and a comment that suppresses
// nothing in the run (stale). Staleness is judged only for the languages the run analysed, decided by the rule id prefix,
// and only on a full analysis: a pull request's analysis reports data-flow results on changed lines alone (diff-informed),
// so `--skip-stale` turns the check off there.
// Run: node scripts/filter-codeql-sarif.mjs --language <matrix language> [--skip-stale] <sarif dir or file>
// Tests: node --test scripts/tests/*.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Rule id prefix of each language an analysis run can cover.
export const RULE_PREFIXES = {
  "javascript-typescript": ["js"],
  rust: ["rust"],
  actions: ["actions"],
};

const SKIPPED_SEGMENTS = new Set(["node_modules", "dist", "target"]);
const COMMENT = /^\s*(?:\/\/|#)\s*codeql\[/;
const RULE_ID = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)+$/;

// Every suppression comment of one file, plus the problems with the malformed ones.
export function parseSuppressions(file, text) {
  const comments = [];
  const problems = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!COMMENT.test(line)) return;
    const at = `${file}:${index + 1}`;
    const body = line.slice(line.indexOf("codeql[") + "codeql[".length);
    const close = body.indexOf("]");
    if (close < 0) {
      problems.push(`${at}: codeql[...] comment is not closed with "]"`);
      return;
    }
    const rule = body.slice(0, close).trim();
    const reason = body.slice(close + 1).trim();
    if (body.slice(close + 1).includes("codeql[") || /[,;\s|]/.test(rule)) {
      problems.push(`${at}: a codeql[...] comment names exactly one rule`);
    } else if (/[*?]/.test(rule)) {
      problems.push(`${at}: codeql[${rule}] uses a wildcard; name the rule id`);
    } else if (!RULE_ID.test(rule)) {
      problems.push(`${at}: codeql[${rule}] is not a rule id such as js/reflected-xss`);
    } else if (reason === "") {
      problems.push(`${at}: codeql[${rule}] has no reason after it`);
    } else {
      comments.push({ file, line: index + 1, rule });
    }
  });
  return { comments, problems };
}

function inScope(rule, language) {
  const prefixes = RULE_PREFIXES[language];
  if (!prefixes) throw new Error(`unknown language "${language}"; known: ${Object.keys(RULE_PREFIXES).join(", ")}`);
  return prefixes.includes(rule.split("/")[0]);
}

const isKnownRule = (rule) => Object.values(RULE_PREFIXES).some((prefixes) => prefixes.includes(rule.split("/")[0]));

function locationsOf(result) {
  return (result.locations ?? [])
    .map((location) => location.physicalLocation)
    .filter((physical) => physical?.artifactLocation?.uri && physical.region?.startLine)
    .map((physical) => ({ file: decodeURIComponent(physical.artifactLocation.uri).replace(/^\.\//, ""), line: physical.region.startLine }));
}

// Removes suppressed results from each SARIF document in place; returns the stale comments.
export function filterSarifs(documents, comments, language) {
  const byPlace = new Map(comments.map((comment) => [`${comment.file}:${comment.line}:${comment.rule}`, comment]));
  const used = new Set();
  for (const document of documents) {
    for (const run of document.runs ?? []) {
      run.results = (run.results ?? []).filter((result) => {
        const suppressing = locationsOf(result)
          .map(({ file, line }) => `${file}:${line - 1}:${result.ruleId}`)
          .find((key) => byPlace.has(key));
        if (suppressing === undefined) return true;
        used.add(suppressing);
        return false;
      });
    }
  }
  return comments.filter((comment) => inScope(comment.rule, language) && !used.has(`${comment.file}:${comment.line}:${comment.rule}`));
}

function trackedFiles(root) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 30 }).toString("utf8");
  return listed
    .split("\0")
    .filter((path) => path !== "" && !path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment)));
}

export function collectSuppressions(root) {
  const comments = [];
  const problems = [];
  for (const path of trackedFiles(root)) {
    const full = join(root, path);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const text = readFileSync(full, "utf8");
    if (!text.includes("codeql[")) continue;
    const parsed = parseSuppressions(path, text);
    comments.push(...parsed.comments);
    problems.push(...parsed.problems);
  }
  return { comments, problems };
}

function sarifPaths(target) {
  if (!existsSync(target)) return [];
  if (statSync(target).isDirectory()) {
    return readdirSync(target)
      .filter((name) => name.endsWith(".sarif"))
      .map((name) => join(target, name));
  }
  return [target];
}

export function run({ root, language, target, judgeStale = true }) {
  const paths = sarifPaths(target);
  if (paths.length === 0) return { errors: [`${target}: no .sarif file to filter`], dropped: 0 };
  const { comments, problems } = collectSuppressions(root);
  const errors = [...problems];
  for (const comment of comments) {
    if (!isKnownRule(comment.rule)) errors.push(`${comment.file}:${comment.line}: codeql[${comment.rule}] has an unknown rule prefix`);
  }
  const documents = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const before = documents.reduce((n, d) => n + (d.runs ?? []).reduce((m, r) => m + (r.results ?? []).length, 0), 0);
  const stale = filterSarifs(documents, comments, language);
  for (const comment of judgeStale ? stale : []) {
    errors.push(`${comment.file}:${comment.line}: codeql[${comment.rule}] suppresses no result in this run; remove the stale comment`);
  }
  const after = documents.reduce((n, d) => n + (d.runs ?? []).reduce((m, r) => m + (r.results ?? []).length, 0), 0);
  if (errors.length === 0) paths.forEach((path, i) => writeFileSync(path, JSON.stringify(documents[i])));
  return { errors, dropped: before - after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--language");
  const language = flag >= 0 ? args[flag + 1] : undefined;
  const judgeStale = !args.includes("--skip-stale");
  const target = args.filter((arg, i) => arg !== "--language" && arg !== "--skip-stale" && i !== flag + 1)[0];
  if (!language || !target) {
    console.error("usage: filter-codeql-sarif.mjs --language <matrix language> [--skip-stale] <sarif dir or file>");
    process.exit(2);
  }
  const { errors, dropped } = run({ root: process.cwd(), language, target, judgeStale });
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(`Dropped ${dropped} suppressed CodeQL result(s) for ${language}.`);
}
