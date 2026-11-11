#!/usr/bin/env node
/**
 * A stand-in for `telo-desktop-host`, speaking its link (`cli/rust/desktop-host/README.md`)
 * on stdin/stdout, for tests of the CLI's desktop host. Point `TELO_HOST_DESKTOP_HELPER`
 * at this file (POSIX only: it runs through its shebang and needs the executable bit;
 * tests that spawn it skip on win32).
 *
 * It answers every request `{ ok: {} }` (`Tray.Open` with `{ ok: { available } }`),
 * validating only the envelope (odd request ids, a known type), exits 0 after
 * `Helper.Quit` and 3 when stdin closes. Everything else is scripted by environment:
 *
 *   FAKE_HELPER_VERSION  the version `Helper.Ready` reports (default "0.0.0")
 *   FAKE_HELPER_TRAY     "false" makes Ready report `tray: false`, and Tray.Open answer unavailable
 *   FAKE_HELPER_LOG      a file each received request is appended to, one JSON line
 *                        `{ id, type, payload }` per request
 *   FAKE_HELPER_STARTED  a file written at start with `{ argv, env }`: the arguments and
 *                        environment the helper was started with
 *   FAKE_HELPER_ERRORS   JSON `{ "<request type>": { code, message } }`: answered as an error
 *   FAKE_HELPER_EMIT     JSON `[ { after: "<request type>", type, payload, delayMs? } ]`: each
 *                        notification is sent right after the response to the first request of
 *                        that type, or `delayMs` later
 *   FAKE_HELPER_INJECT   a file polled every 50 ms; each line appended to it is a JSON
 *                        `{ type, payload }` notification sent at that moment
 *   FAKE_HELPER_EXIT     JSON `{ after: "<request type>", code }`: exits with `code` right after
 *                        answering the first request of that type, with no `Helper.Quit`
 *   FAKE_HELPER_MODE     the start-up behaviour:
 *     ready (default)             Ready, then serve
 *     unavailable                 `Helper.Unavailable { reason: "no webview runtime" }`, exit 1
 *     exit-before-ready           writes a line to stderr and exits 1 with no frame
 *     violate-odd-notification    after Init's response: a notification with an odd id
 *     violate-unknown-type        after Init's response: a notification of an unknown type
 *     violate-extra-member        after Init's response: Window.Closed with a member it does not list
 *     violate-data-frame          after Init's response: a data frame
 *     ignore-quit                 never answers Helper.Quit and does not exit
 *
 * Every stderr line it writes starts with `fake-helper:`.
 */
import fs from "node:fs";

const env = process.env;
const mode = env.FAKE_HELPER_MODE ?? "ready";
const version = env.FAKE_HELPER_VERSION ?? "0.0.0";
const tray = env.FAKE_HELPER_TRAY !== "false";
const errors = JSON.parse(env.FAKE_HELPER_ERRORS ?? "{}");
const emits = JSON.parse(env.FAKE_HELPER_EMIT ?? "[]");
const log = env.FAKE_HELPER_LOG;
const exitAfter = JSON.parse(env.FAKE_HELPER_EXIT ?? "null");

let notificationId = 0;

if (env.FAKE_HELPER_INJECT) {
  let offset = 0;
  setInterval(() => {
    if (!fs.existsSync(env.FAKE_HELPER_INJECT)) return;
    const text = fs.readFileSync(env.FAKE_HELPER_INJECT, "utf8");
    const end = text.lastIndexOf("\n") + 1;
    for (const line of text.slice(offset, end).split("\n").filter(Boolean)) {
      const { type, payload } = JSON.parse(line);
      notify(type, payload);
    }
    offset = end;
  }, 50).unref();
}

if (env.FAKE_HELPER_STARTED) {
  fs.writeFileSync(env.FAKE_HELPER_STARTED, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function frame(cls, meta) {
  const metaBytes = Buffer.from(meta, "utf8");
  const out = Buffer.alloc(4 + 5 + metaBytes.length);
  out.writeUInt32BE(5 + metaBytes.length, 0);
  out[4] = cls;
  out.writeUInt32BE(metaBytes.length, 5);
  metaBytes.copy(out, 9);
  return out;
}

const send = (id, type, payload, cls = 0x01) => process.stdout.write(frame(cls, canonical({ id, payload, type })));
const notify = (type, payload, id) => send(id ?? (notificationId += 2) , type, payload);

if (mode === "exit-before-ready") {
  process.stderr.write("fake-helper: exiting before Ready\n");
  process.exit(1);
}
if (mode === "unavailable") {
  notify("Helper.Unavailable", { reason: "no webview runtime" });
  setTimeout(() => process.exit(1), 20);
} else {
  notify("Helper.Ready", { tray, version });
  process.stderr.write("fake-helper: ready\n");
}

let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) return;
    const metaLength = buffered.readUInt32BE(5);
    const meta = buffered.subarray(9, 9 + metaLength).toString("utf8");
    buffered = buffered.subarray(4 + length);
    handle(JSON.parse(meta));
  }
});
process.stdin.on("end", () => process.exit(3));

function handle({ id, type, payload }) {
  if (id % 2 !== 1) {
    process.stderr.write(`fake-helper: even request id ${id}\n`);
    process.exit(2);
  }
  if (log) fs.appendFileSync(log, `${JSON.stringify({ id, type, payload })}\n`);
  if (type === "Helper.Quit" && mode === "ignore-quit") {
    process.stdin.removeAllListeners("end");
    return;
  }
  if (errors[type]) send(id, type, { error: errors[type] });
  else if (type === "Tray.Open") send(id, type, { ok: { available: tray } });
  else send(id, type, { ok: {} });
  if (type === "Helper.Quit") process.exit(0);
  for (const e of emits) {
    if (e.after !== type) continue;
    if (e.delayMs) setTimeout(() => notify(e.type, e.payload), e.delayMs);
    else notify(e.type, e.payload);
  }
  if (type === "Helper.Init") violateAfterInit();
  if (exitAfter?.after === type) setTimeout(() => process.exit(exitAfter.code), 10);
}

function violateAfterInit() {
  if (mode === "violate-odd-notification") notify("Window.Closed", { window: "w" }, 3);
  if (mode === "violate-unknown-type") notify("Window.Exploded", {});
  if (mode === "violate-extra-member") notify("Window.Closed", { window: "w", extra: 1 });
  if (mode === "violate-data-frame") process.stdout.write(frame(0x02, canonical({ id: 2, payload: {}, type: "Window.Closed" })));
}
