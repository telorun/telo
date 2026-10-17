// Usage: node cache-misses.mjs ~/.claude/projects/<project>
// Per role: tokens written to cache vs peak context, and cache-miss events
// (a turn re-reading < half of the previous turn's context, previous context > 50k), with the gap before each.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
function scan(file) {
  const byId = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "assistant" || !e.message?.usage || e.message.model === "<synthetic>") continue;
    byId.set(e.message.id ?? e.uuid, { t: Date.parse(e.timestamp), u: e.message.usage });
  }
  let prev = 0, prevT = 0, peak = 0, written = 0, misses = 0, missWritten = 0; const gaps = [];
  for (const { t, u } of byId.values()) {
    const read = u.cache_read_input_tokens ?? 0, w = u.cache_creation_input_tokens ?? 0;
    const ctx = read + w + (u.input_tokens ?? 0);
    if (prev > 50000 && read < prev / 2) { misses++; missWritten += w; gaps.push(Math.round((t - prevT) / 1000)); }
    written += w; peak = Math.max(peak, ctx); prev = ctx; prevT = t;
  }
  return { peak, written, misses, missWritten, gaps };
}
const roles = {};
for (const s of readdirSync(dir, { withFileTypes: true })) {
  if (!s.isDirectory()) continue; const sub = join(dir, s.name, "subagents"); if (!existsSync(sub)) continue;
  const metas = readdirSync(sub).filter(f => f.endsWith(".meta.json"));
  const list = metas.map(f => [JSON.parse(readFileSync(join(sub, f))).agentType, join(sub, f.replace(".meta.json", ".jsonl"))]);
  if (!list.some(([t]) => t?.startsWith("builder"))) continue;
  list.push(["architect", join(dir, `${s.name}.jsonl`)]);
  for (const [t, f] of list) { if (!existsSync(f)) continue; const r = scan(f); const x = roles[t] ??= { n: 0, peak: 0, written: 0, misses: 0, missWritten: 0, gaps: [] };
    x.n++; x.peak += r.peak; x.written += r.written; x.misses += r.misses; x.missWritten += r.missWritten; x.gaps.push(...r.gaps); }
}
for (const [t, x] of Object.entries(roles)) {
  const g = x.gaps.sort((a, b) => a - b); const med = g[Math.floor(g.length / 2)] ?? 0;
  console.log(`${t.padEnd(14)} n=${x.n} written/peak=${(x.written / x.peak).toFixed(2)} misses/agent=${(x.misses / x.n).toFixed(1)} miss-rewrite share of writes=${(100 * x.missWritten / x.written).toFixed(0)}% median gap before miss=${med}s`);
}
