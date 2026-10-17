// Usage: node loop-cost.mjs ~/.claude/projects/<project>
// Per loop session (a session whose subagents include a builder): the main
// session's and each subagent's turns, peak context, and cost split into
// cache write / cache read / uncached input / output.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const PRICE = {
  opus: { in: 4, read: 0.2, w5: 5, w1h: 8, out: 20 },
  sonnet: { in: 2, read: 0.2, w5: 2.5, w1h: 4, out: 10 },
  haiku: { in: 0.1, read: 0.01, w5: 0.125, w1h: 0.2, out: 0.5 },
};
const family = (m = "") => (m.includes("sonnet") ? "sonnet" : m.includes("haiku") ? "haiku" : "opus");

function measure(file) {
  const byId = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "assistant" || !e.message?.usage) continue;
    byId.set(e.message.id ?? e.uuid, { model: e.message.model, u: e.message.usage });
  }
  const r = { turns: 0, peak: 0, read: 0, w5: 0, w1h: 0, inp: 0, out: 0, cost: { read: 0, write: 0, inp: 0, out: 0 }, model: "" };
  for (const { model, u } of byId.values()) {
    if (model === "<synthetic>") continue;
    const p = PRICE[family(model)];
    r.model = model;
    r.turns++;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5 = (u.cache_creation_input_tokens ?? 0) - w1h;
    const read = u.cache_read_input_tokens ?? 0;
    const inp = u.input_tokens ?? 0;
    const out = u.output_tokens ?? 0;
    r.peak = Math.max(r.peak, read + w5 + w1h + inp);
    r.read += read; r.w5 += w5; r.w1h += w1h; r.inp += inp; r.out += out;
    r.cost.read += (read * p.read) / 1e6;
    r.cost.write += (w5 * p.w5 + w1h * p.w1h) / 1e6;
    r.cost.inp += (inp * p.in) / 1e6;
    r.cost.out += (out * p.out) / 1e6;
  }
  r.total = r.cost.read + r.cost.write + r.cost.inp + r.cost.out;
  return r;
}

const k = (n) => `${Math.round(n / 1000)}k`;
const $ = (n) => `$${n.toFixed(2)}`;
const row = (name, r) =>
  `${name.padEnd(22)} ${String(r.turns).padStart(5)} ${k(r.peak).padStart(6)} ${k(r.read + r.w5 + r.w1h + r.inp).padStart(8)} ` +
  `${$(r.cost.write).padStart(8)} ${$(r.cost.read).padStart(8)} ${$(r.cost.out).padStart(8)} ${$(r.total).padStart(9)}`;

const totals = {};
for (const session of readdirSync(dir, { withFileTypes: true })) {
  if (!session.isDirectory()) continue;
  const sub = join(dir, session.name, "subagents");
  if (!existsSync(sub)) continue;
  const agents = readdirSync(sub).filter((f) => f.endsWith(".meta.json")).map((f) => {
    const meta = JSON.parse(readFileSync(join(sub, f), "utf8"));
    return { type: meta.agentType, ...measure(join(sub, f.replace(".meta.json", ".jsonl"))) };
  });
  if (!agents.some((a) => a.type === "builder" || a.type === "builder-lite")) continue;
  const mainFile = join(dir, `${session.name}.jsonl`);
  if (!existsSync(mainFile)) continue;
  const main = measure(mainFile);
  console.log(`\n== ${session.name}`);
  console.log(`${"agent".padEnd(22)} turns   peak   billed-in    write     read      out     total`);
  console.log(row("architect (main)", main));
  const add = (t, r) => {
    totals[t] ??= { n: 0, turns: 0, peak: 0, total: 0, read: 0, write: 0, out: 0 };
    const x = totals[t];
    x.n++; x.turns += r.turns; x.peak += r.peak; x.total += r.total; x.read += r.cost.read; x.write += r.cost.write; x.out += r.cost.out;
  };
  add("architect", main);
  let sum = main.total;
  for (const a of agents.sort((x, y) => y.total - x.total)) {
    console.log(row(a.type, a));
    add(a.type, a);
    sum += a.total;
  }
  console.log(`session total ${$(sum)}`);
}
console.log(`\n== by role (all sessions)`);
console.log(`${"role".padEnd(14)}   n  avg-turns avg-peak   total    read%   write%    out%`);
for (const [t, x] of Object.entries(totals).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${t.padEnd(14)} ${String(x.n).padStart(3)} ${String(Math.round(x.turns / x.n)).padStart(10)} ${k(x.peak / x.n).padStart(8)} ${$(x.total).padStart(8)} ` +
    `${((100 * x.read) / x.total).toFixed(0).padStart(7)}% ${((100 * x.write) / x.total).toFixed(0).padStart(7)}% ${((100 * x.out) / x.total).toFixed(0).padStart(6)}%`);
}
