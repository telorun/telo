// Stands in for `telo run …` in the local runner's tests: records what it was
// started with beside the entry it was given, then stays up as `--watch` does
// until it is signalled — or exits with `FAKE_TELO_EXIT` when that is set.
import { renameSync, writeFileSync } from "node:fs";

const RECORDED_ENV = [
  "WORKSPACE_DIR",
  "TELO_HOST_STATE_DIR",
  "TELO_CACHE_DIR",
  "AGENT_TOKEN",
  "AGENT_PROBE",
  "AGENT_ENV",
];

const entry = process.argv.at(-1);
// Written aside and renamed into place, so a test polling for the file never
// reads it half-written.
const seen = `${entry}.seen.json`;
writeFileSync(
  `${seen}.${process.pid}.tmp`,
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    pid: process.pid,
    probe: process.env.RUN_PROBE ?? null,
    env: Object.fromEntries(RECORDED_ENV.map((name) => [name, process.env[name] ?? null])),
  }),
);
renameSync(`${seen}.${process.pid}.tmp`, seen);
if (process.env.FAKE_TELO_EXIT !== undefined) process.exit(Number(process.env.FAKE_TELO_EXIT));
setInterval(() => {}, 1 << 30);
