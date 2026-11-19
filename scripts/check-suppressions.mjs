#!/usr/bin/env node
// One suppression rule for every scanner: an entry names ONE advisory id, carries a reason and an
// expiry at most 90 days ahead, and ignores no whole package. `deny.toml` carries no expiry, so its
// ignore list must be exactly the RUSTSEC entries of `osv-scanner.toml` (same ids, same reasons),
// whose expiry then governs both.
//
// Files: osv-scanner.toml, deny.toml (advisories.ignore), .trivyignore.yaml.
// Usage: node scripts/check-suppressions.mjs     (exit 1 when any entry is refused)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const MAX_DAYS = 90;
const DAY_MS = 86_400_000;
const ADVISORY_ID = /^(?:GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|RUSTSEC-\d{4}-\d{4}|CVE-\d{4}-\d{4,}|GO-\d{4}-\d{4,})$/i;
const OSV_FILE = "osv-scanner.toml";
const DENY_FILE = "deny.toml";
const TRIVY_FILE = ".trivyignore.yaml";

// ---- a TOML subset: tables, arrays of tables, strings, dates, numbers, booleans, arrays, inline tables ----

class TomlError extends Error {}

export function parseToml(text) {
  let i = 0;
  const root = {};
  let table = root;

  const fail = (what) => {
    const line = text.slice(0, i).split("\n").length;
    throw new TomlError(`line ${line}: ${what}`);
  };
  const skipBlank = (newlines) => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) i++;
      else if (c === "#") while (i < text.length && text[i] !== "\n") i++;
      else return;
    }
  };
  const expect = (ch) => {
    if (text[i] !== ch) fail(`expected "${ch}"`);
    i++;
  };

  const basicString = () => {
    expect('"');
    let out = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") fail("unterminated string");
      if (text[i] === "\\") {
        const e = text[i + 1];
        const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
        if (e in simple) {
          out += simple[e];
          i += 2;
        } else if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 2 + len), 16));
          i += 2 + len;
        } else fail(`bad escape \\${e}`);
      } else out += text[i++];
    }
    expect('"');
    return out;
  };
  const literalString = () => {
    expect("'");
    const end = text.indexOf("'", i);
    if (end < 0 || text.slice(i, end).includes("\n")) fail("unterminated string");
    const out = text.slice(i, end);
    i = end + 1;
    return out;
  };
  const key = () => {
    skipBlank(false);
    if (text[i] === '"') return basicString();
    if (text[i] === "'") return literalString();
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (!m) fail("expected a key");
    i += m[0].length;
    return m[0];
  };
  const keyPath = () => {
    const parts = [key()];
    for (skipBlank(false); text[i] === "."; skipBlank(false)) {
      i++;
      parts.push(key());
    }
    return parts;
  };
  const value = () => {
    skipBlank(false);
    const c = text[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      i++;
      const out = [];
      for (;;) {
        skipBlank(true);
        if (text[i] === "]") break;
        out.push(value());
        skipBlank(true);
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail('expected "," or "]"');
      }
      i++;
      return out;
    }
    if (c === "{") {
      i++;
      const out = {};
      for (;;) {
        skipBlank(false);
        if (text[i] === "}") break;
        assign(out, keyPath());
        skipBlank(false);
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail('expected "," or "}"');
      }
      i++;
      return out;
    }
    const m = /^[^\s,\]}#]+/.exec(text.slice(i));
    if (!m) fail("expected a value");
    i += m[0].length;
    const raw = m[0];
    if (raw === "true" || raw === "false") return raw === "true";
    if (/^\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.]+(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(raw)) return { date: raw };
    if (/^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw.replaceAll("_", ""));
    return fail(`unsupported value "${raw}"`);
  };
  const assign = (into, path) => {
    skipBlank(false);
    expect("=");
    const v = value();
    let t = into;
    for (const part of path.slice(0, -1)) t = t[part] ??= {};
    t[path.at(-1)] = v;
  };
  const descend = (path, arrayOfTables) => {
    let t = root;
    path.forEach((part, n) => {
      const last = n === path.length - 1;
      if (last && arrayOfTables) {
        (t[part] ??= []).push((t = {}));
      } else {
        t = t[part] ??= {};
        if (Array.isArray(t)) t = t.at(-1);
      }
    });
    return t;
  };

  for (;;) {
    skipBlank(true);
    if (i >= text.length) break;
    if (text.startsWith("[[", i)) {
      i += 2;
      const path = keyPath();
      skipBlank(false);
      expect("]");
      expect("]");
      table = descend(path, true);
    } else if (text[i] === "[") {
      i++;
      const path = keyPath();
      skipBlank(false);
      expect("]");
      table = descend(path, false);
    } else {
      assign(table, keyPath());
    }
    skipBlank(false);
    if (i < text.length && text[i] !== "\n") fail("unexpected text after a value");
  }
  return root;
}

// ---- the rule ----

const dayOf = (v) => {
  const text = typeof v === "object" && v !== null && "date" in v ? v.date : v instanceof Date ? v.toISOString() : v;
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const ms = Date.parse(`${text.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
};

function judgeEntry({ file, label, id, reason, reasonKey, expiry, expiryKey, today, out }) {
  const refuse = (what) => out.push({ file, entry: label, reason: what });
  if (typeof id !== "string" || id.trim() === "") refuse("names no advisory id");
  else if (!ADVISORY_ID.test(id)) refuse(`"${id}" is not a single advisory id (a package-wide or multi-id ignore is refused)`);
  if (typeof reason !== "string" || reason.trim() === "") refuse(`has no ${reasonKey}`);
  if (expiry === undefined || expiry === null || expiry === "") {
    refuse(`has no ${expiryKey}`);
    return;
  }
  const day = dayOf(expiry);
  if (day === null) refuse(`${expiryKey} is not a date (YYYY-MM-DD)`);
  else if (day <= today) refuse(`${expiryKey} ${new Date(day).toISOString().slice(0, 10)} is already past`);
  else if (day - today > MAX_DAYS * DAY_MS) refuse(`${expiryKey} ${new Date(day).toISOString().slice(0, 10)} is more than ${MAX_DAYS} days ahead`);
}

function osvEntries({ root, today, out }) {
  const path = join(root, OSV_FILE);
  if (!existsSync(path)) return [];
  let doc;
  try {
    doc = parseToml(readFileSync(path, "utf8"));
  } catch (e) {
    out.push({ file: OSV_FILE, entry: "(file)", reason: `cannot be read: ${e.message}` });
    return [];
  }
  for (const [n, o] of (doc.PackageOverrides ?? []).entries()) {
    if (o.ignore === true) out.push({ file: OSV_FILE, entry: `PackageOverrides #${n + 1}${o.name ? ` (${o.name})` : ""}`, reason: "ignores a whole package" });
  }
  const entries = doc.IgnoredVulns ?? [];
  entries.forEach((e, n) => {
    judgeEntry({
      file: OSV_FILE, label: e.id ? String(e.id) : `IgnoredVulns #${n + 1}`, id: e.id,
      reason: e.reason, reasonKey: "reason", expiry: e.effectiveUntil, expiryKey: "effectiveUntil", today, out,
    });
  });
  return entries;
}

function denyIgnores({ root, out }) {
  const path = join(root, DENY_FILE);
  if (!existsSync(path)) return null;
  let doc;
  try {
    doc = parseToml(readFileSync(path, "utf8"));
  } catch (e) {
    out.push({ file: DENY_FILE, entry: "(file)", reason: `cannot be read: ${e.message}` });
    return null;
  }
  const list = doc.advisories?.ignore ?? [];
  const seen = [];
  list.forEach((e, n) => {
    const label = typeof e === "string" ? e : (e.id ?? `advisories.ignore #${n + 1}`);
    const id = typeof e === "string" ? e : e.id;
    const refuse = (what) => out.push({ file: DENY_FILE, entry: String(label), reason: what });
    if (typeof id !== "string" || !ADVISORY_ID.test(id)) refuse(`"${id ?? ""}" is not a single advisory id (a crate-wide ignore is refused)`);
    if (typeof e === "string" || typeof e.reason !== "string" || e.reason.trim() === "") refuse("has no reason");
    seen.push({ id, reason: typeof e === "object" ? e.reason : undefined });
  });
  return seen;
}

function trivyEntries({ root, today, out }) {
  const path = join(root, TRIVY_FILE);
  if (!existsSync(path)) return;
  let doc;
  try {
    doc = parseYaml(readFileSync(path, "utf8")) ?? {};
  } catch (e) {
    out.push({ file: TRIVY_FILE, entry: "(file)", reason: `cannot be read: ${e.message}` });
    return;
  }
  for (const section of ["vulnerabilities", "misconfigurations", "secrets", "licenses"]) {
    (doc[section] ?? []).forEach((e, n) => {
      judgeEntry({
        file: TRIVY_FILE, label: `${section}: ${e?.id ?? `#${n + 1}`}`, id: e?.id,
        reason: e?.statement, reasonKey: "statement", expiry: e?.expired_at, expiryKey: "expired_at", today, out,
      });
    });
  }
}

/** Every refusal over the suppression files under `root`, judged on the day `today` (a Date). */
export function refusalsFor({ root, today = new Date() }) {
  const out = [];
  const day = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const osv = osvEntries({ root, today: day, out });
  const deny = denyIgnores({ root, out });
  trivyEntries({ root, today: day, out });

  if (deny !== null) {
    const rust = new Map(osv.filter((e) => typeof e.id === "string" && e.id.toUpperCase().startsWith("RUSTSEC-")).map((e) => [e.id, e.reason]));
    const denied = new Map(deny.map((e) => [e.id, e.reason]));
    for (const [id, reason] of rust) {
      if (!denied.has(id)) out.push({ file: DENY_FILE, entry: id, reason: `is in ${OSV_FILE} but missing from advisories.ignore` });
      else if (denied.get(id) !== reason) out.push({ file: DENY_FILE, entry: id, reason: `reason differs from the one in ${OSV_FILE}` });
    }
    for (const id of denied.keys()) {
      if (typeof id === "string" && !rust.has(id)) out.push({ file: DENY_FILE, entry: id, reason: `is not an entry of ${OSV_FILE} (it carries the expiry)` });
    }
  }
  return out;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const refused = refusalsFor({ root });
  for (const { file, entry, reason } of refused) console.log(`${file}: ${entry}  ${reason}`);
  if (refused.length > 0) {
    console.log(`${refused.length} suppression${refused.length === 1 ? "" : "s"} refused`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
