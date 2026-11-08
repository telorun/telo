// A subject for the comparison tests: answers /ping, records how each boot found its state
// directory and cache, and can stall its event loop for STALL_MS once every second.
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const stateDir = process.env.STATE_DIR;
const stateWasEmpty = stateDir ? readdirSync(stateDir).length === 0 : null;
if (stateDir) writeFileSync(`${stateDir}/written`, "x");
const cacheExisted = existsSync(".cache");
mkdirSync(".cache", { recursive: true });
if (process.env.BOOT_LOG) {
  appendFileSync(process.env.BOOT_LOG, JSON.stringify({ pid: process.pid, stateDir, stateWasEmpty, cacheExisted }) + "\n");
}

const stallMs = Number(process.env.STALL_MS ?? 0);
if (stallMs > 0) {
  setInterval(() => {
    const until = Date.now() + stallMs;
    while (Date.now() < until);
  }, 1000);
}

const server = createServer((req, res) => {
  if (req.url === "/ping") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pong");
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "NOT_FOUND", path: req.url }));
  }
});
server.on("error", (error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
