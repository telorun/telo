// Stands in for `telo run …` in the local runner's tests: records what it was
// started with beside the entry it was given, then stays up as `--watch` does
// until it is signalled.
import { writeFileSync } from "node:fs";

const entry = process.argv.at(-1);
writeFileSync(
  `${entry}.seen.json`,
  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), probe: process.env.RUN_PROBE ?? null }),
);
setInterval(() => {}, 1 << 30);
