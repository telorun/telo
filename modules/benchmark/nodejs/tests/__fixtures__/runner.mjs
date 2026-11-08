// A subject that runs to exit: writes a startup span to TRACE_FILE when SPAN_MS is set,
// exits with EXIT_CODE, or never exits when HANG is set. An empty variable counts as unset.
import { appendFileSync } from "node:fs";

if (process.env.SPAN_MS) {
  appendFileSync(process.env.TRACE_FILE, JSON.stringify({ msg: "kernel ready", event_name: "telo.log" }) + "\n");
  appendFileSync(
    process.env.TRACE_FILE,
    JSON.stringify({
      msg: "startup RunnerFixture",
      event_name: "telo.span",
      attributes: { "telo.span.outcome": "ok", "telo.span.duration_ms": Number(process.env.SPAN_MS) },
    }) + "\n",
  );
}
if (process.env.HANG) setInterval(() => {}, 1000);
else {
  if (process.env.EXIT_CODE) console.error(`runner failing with ${process.env.EXIT_CODE}`);
  process.exitCode = Number(process.env.EXIT_CODE ?? 0);
}
