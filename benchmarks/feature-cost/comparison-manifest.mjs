// The Benchmark.Comparison written beside each generated application: no workloads, so it
// times boots only -- `telo run` to exit and `telo check` -- and history carries the statistics.

export const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const pascal = (s) => s[0].toUpperCase() + s.slice(1);

// `command` may be several words (`bun path/to/telo.ts`); the first is the program.
export function comparisonManifest({ feature, n, rounds, bootTimeout, teloCommand }) {
  const slug = `${kebab(feature)}-${n}`;
  const name = `${feature}${n}`;
  const [program, ...prefix] = teloCommand;
  const args = (...rest) => `[${[...prefix, ...rest].map((a) => JSON.stringify(a)).join(", ")}]`;
  return `kind: Telo.Application
metadata:
  name: FeatureCost${pascal(feature)}${n}
imports:
  Benchmark: ../../../modules/benchmark
variables:
  reportFile:
    env: REPORT_FILE
    type: string
    x-telo-type: Telo.HostPath
    default: ./${slug}.json
targets:
  - !ref ${name}
---
kind: Benchmark.Comparison
metadata:
  name: ${name}
rounds: ${rounds}
boots: 1
subjects:
  - name: run
    command: ${JSON.stringify(program)}
    args: ${args("run", "telo.yaml")}
    cwd: !module-path ${slug}
    env: { TRACE: "true", TELO_CACHE_DIR: .telo }
    caches: [.telo]
    bootTimeout: ${bootTimeout}
    traceFile: spans.jsonl
  - name: check
    command: ${JSON.stringify(program)}
    args: ${args("check", "telo.yaml")}
    cwd: !module-path ${slug}
    env: { TELO_CACHE_DIR: .telo }
    caches: [.telo]
    bootTimeout: ${bootTimeout}
report:
  file: !cel "variables.reportFile"
`;
}
