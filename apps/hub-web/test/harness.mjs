// Boots the production `server.mjs` against the built output and a stub hub,
// both on port 0, for the `*.test.mjs` files beside this one.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");

/** A hub stub whose behaviour each test swaps through `handle`. Every request
 *  it receives is recorded in `requests` as its path and query. */
export async function startStubHub() {
  const stub = {
    requests: [],
    handle: (req, res) => {
      res.writeHead(500);
      res.end();
    },
  };
  const server = createServer((req, res) => {
    stub.requests.push(req.url);
    stub.handle(req, res, new URL(req.url, "http://stub"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.origin = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return stub;
}

/** A port nothing listens on: bound, then released. */
export async function closedPortOrigin() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

export function runServer(env) {
  return spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { PATH: process.env.PATH, NODE_ENV: "production", PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Starts hub-web and resolves once it listens. */
export async function startHubWeb({ hubOrigin, siteOrigin = "https://hub.example" }) {
  const child = runServer({ HUB_API_ORIGIN: hubOrigin, SITE_ORIGIN: siteOrigin });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const port = await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /listening on port (\d+)/.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.on("exit", (code) => reject(new Error(`hub-web exited ${code} before listening:\n${stderr}`)));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    stderr: () => stderr,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      }),
  };
}

/** A GET that does not follow redirects. */
export function get(origin, pathAndQuery) {
  return fetch(`${origin}${pathAndQuery}`, { redirect: "manual" });
}

/** The `/modules` contract over an in-memory catalogue, ascending by `seq`. */
export function catalogueResponse(entries, url) {
  const after = Number(url.searchParams.get("after") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 1000);
  const modules = entries.filter((m) => m.seq > after).slice(0, limit);
  const next = modules.length === limit ? modules[modules.length - 1].seq : null;
  return { modules, next };
}

export function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
