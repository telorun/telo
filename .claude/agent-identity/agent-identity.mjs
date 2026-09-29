#!/usr/bin/env node
// GitHub App identity shared by the campaign skills. See README.md beside this file.
import { execFileSync, spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "telorun/telo";
const API = "https://api.github.com";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

const home = process.env.TELORUN_AGENT_HOME ?? join(homedir(), ".config", "telorun-agent");
const cacheDir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "telorun-agent");
const tokenCache = join(cacheDir, "token.json");
const self = fileURLToPath(import.meta.url);

function loadConfig() {
  const file = join(home, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["appId", "botUserId", "botLogin", "owner", "coAuthor"]) {
    if (config[key] === undefined || config[key] === "") {
      throw new Error(`${file}: missing "${key}"`);
    }
  }
  return config;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function appJwt(config) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(config.appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(readFileSync(join(home, "app.pem"), "utf8")).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function github(method, path, jwt, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

function readCachedToken() {
  let cached;
  try {
    cached = JSON.parse(readFileSync(tokenCache, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return Date.parse(cached.expiresAt) - Date.now() > REFRESH_MARGIN_MS ? cached.token : undefined;
}

async function mintToken(config) {
  const jwt = appJwt(config);
  const installation = await github("GET", `/repos/${REPO}/installation`, jwt);
  const minted = await github("POST", `/app/installations/${installation.id}/access_tokens`, jwt, {
    repositories: [REPO.split("/")[1]],
  });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const staging = `${tokenCache}.${process.pid}`;
  writeFileSync(staging, JSON.stringify({ token: minted.token, expiresAt: minted.expires_at }), { mode: 0o600 });
  renameSync(staging, tokenCache);
  return minted.token;
}

async function token(config) {
  return readCachedToken() ?? (await mintToken(config));
}

function botEmail(config) {
  return `${config.botUserId}+${config.botLogin}@users.noreply.github.com`;
}

async function credential(config, operation) {
  const request = Object.fromEntries(
    readFileSync(0, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (operation !== "get" || request.protocol !== "https" || request.host !== "github.com") return;
  process.stdout.write(`username=x-access-token\npassword=${await token(config)}\n`);
}

async function configure(config) {
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  if (git("rev-parse", "--absolute-git-dir") === git("rev-parse", "--path-format=absolute", "--git-common-dir")) {
    throw new Error("configure must run in a linked worktree, never in the main checkout");
  }
  await token(config);
  git("config", "extensions.worktreeConfig", "true");
  const set = (key, value) => git("config", "--worktree", key, value);
  set("user.name", config.botLogin);
  set("user.email", botEmail(config));
  set("remote.origin.pushurl", `https://github.com/${REPO}.git`);
  // The empty entry resets helpers inherited from global config, so only the app answers.
  git("config", "--worktree", "--replace-all", "credential.https://github.com.helper", "");
  git("config", "--worktree", "--add", "credential.https://github.com.helper", `!node ${self} credential`);
  process.stdout.write(
    JSON.stringify(
      { bot: `${config.botLogin} <${botEmail(config)}>`, owner: config.owner, coAuthor: config.coAuthor },
      null,
      2,
    ) + "\n",
  );
}

async function gh(config, args) {
  const env = { ...process.env, GH_TOKEN: await token(config) };
  delete env.GITHUB_TOKEN;
  const result = spawnSync("gh", args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();
switch (command) {
  case "token":
    process.stdout.write(`${await token(config)}\n`);
    break;
  case "credential":
    await credential(config, rest[0]);
    break;
  case "configure":
    await configure(config);
    break;
  case "gh":
    await gh(config, rest);
    break;
  default:
    throw new Error("usage: agent-identity.mjs token | credential <get|store|erase> | configure | gh <args…>");
}
