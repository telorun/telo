// The family-1 comparison over the apps agents built: a Benchmark.Comparison in the shape of
// benchmarks/lead-intake/comparison.yaml, with the built apps as subjects.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { teloCommand } from "./app-launcher.mjs";
import { repoRoot } from "./tasks.mjs";

const PORT = 8845;
const flow = (value) => JSON.stringify(value);

// `scripts.start` of the built Node app as a direct `node` invocation, so npm's own process is not
// measured with the app; any other script keeps `npm start --silent`.
export function nodeStartCommand(packageJsonPath) {
  const start = JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts?.start;
  const direct = typeof start === "string" && /^node((?:\s+[^\s;&|<>$`"'\\()*?{}]+)+)\s*$/.exec(start);
  return direct
    ? { command: "node", args: direct[1].trim().split(/\s+/), direct: true }
    : { command: "npm", args: ["start", "--silent"], direct: false };
}

function subject(side, directory, base) {
  const [program, ...prefix] = teloCommand();
  const node = side === "node" ? nodeStartCommand(join(base, directory, "package.json")) : undefined;
  const run =
    side === "telo"
      ? { command: program, args: [...prefix, "run", "telo.yaml"], caches: "    caches: [.telo]\n", env: `, TELO_CACHE_DIR: .telo` }
      : { command: node.command, args: node.args, caches: "", env: "" };
  const note = node && !node.direct ? "  # scripts.start is not a plain `node` command: npm's process is measured with the app\n" : "";
  return `${note}  - name: ${side === "telo" ? "agentTelo" : "agentNode"}
    command: ${flow(run.command)}
    args: ${flow(run.args)}
    cwd: !module-path ${directory}
    env: { PORT: "${PORT}"${run.env} }
    readiness: { url: "http://127.0.0.1:${PORT}/ping" }
${run.caches}    stateDirectory: { env: STATE_DIR }
`;
}

const WORKLOADS = `workloads:
  - name: ping
    duration: 30s
    warmup: 5s
    concurrency: 64
    rate: 2000
    requests:
      - { method: GET, url: "http://127.0.0.1:${PORT}/ping", expect: { status: 200 } }
  - name: leads
    duration: 30s
    warmup: 5s
    concurrency: 64
    rate: 1000
    requests:
      - method: POST
        url: "http://127.0.0.1:${PORT}/leads/heavy"
        weight: 3
        headers: { content-type: application/json }
        body:
          email: alice.johnson@acme-corp.com
          company: { name: Acme Corp, employees: 850, country: US, industry: saas }
          plan: growth
        expect: { status: 201 }
      - { method: GET, url: "http://127.0.0.1:${PORT}/leads/seed", expect: { status: 200 } }
      - method: POST
        url: "http://127.0.0.1:${PORT}/leads/light"
        headers: { content-type: application/json }
        body: { email: not-an-email }
        expect: { status: 400 }
`;

// Writes <directory>/comparison.yaml over the apps at <directory>/built/<side> for each side in
// `sides`, and returns its path. Each app directory must exist: `!module-path` names it.
export function writeComparison({ directory, sides }) {
  if (sides.length === 0) throw new Error("a comparison needs at least one built app");
  const subjects = sides.map((side) => {
    const app = join("built", side);
    if (!existsSync(join(directory, app))) throw new Error(`no built ${side} app at ${join(directory, app)}`);
    return subject(side, app, directory);
  });
  const benchmarkModule = relative(directory, join(repoRoot, "modules/benchmark")).split("\\").join("/");
  const manifest = `kind: Telo.Application
metadata: { name: AgentBuiltLeadIntakeComparison }
imports: { Benchmark: ${benchmarkModule} }
variables:
  reportFile:
    env: REPORT_FILE
    type: string
    x-telo-type: Telo.HostPath
    default: ./comparison.json
targets:
  - !ref agentBuilt
---
kind: Benchmark.Comparison
metadata: { name: agentBuilt }
rounds: 5
boots: 20
subjects:
${subjects.join("")}${WORKLOADS}report:
  file: !cel "variables.reportFile"
`;
  const path = join(directory, "comparison.yaml");
  writeFileSync(path, manifest);
  return path;
}
