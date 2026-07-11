import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { hostEnv } from "../../host-env.js";

export interface DockerCredential {
  username: string;
  password: string;
}

interface DockerConfig {
  auths?: Record<string, { auth?: string; username?: string; password?: string }>;
  credHelpers?: Record<string, string>;
  credsStore?: string;
}

/** Path to `config.json`, honouring `DOCKER_CONFIG`. */
function dockerConfigPath(): string {
  const override = hostEnv().DOCKER_CONFIG;
  const dir = override && override.trim() ? override.trim() : path.join(homedir(), ".docker");
  return path.join(dir, "config.json");
}

async function readDockerConfig(): Promise<DockerConfig | null> {
  try {
    return JSON.parse(await readFile(dockerConfigPath(), "utf-8")) as DockerConfig;
  } catch {
    return null; // no config, unreadable, or malformed → anonymous
  }
}

/** Run `docker-credential-<helper> get` with `host` on stdin, per the Docker
 *  credential-helper protocol, returning `{Username, Secret}` or null. */
function runCredentialHelper(helper: string, host: string): Promise<DockerCredential | null> {
  return new Promise((resolve) => {
    const proc = spawn(`docker-credential-${helper}`, ["get"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("error", () => resolve(null)); // helper binary not installed
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(out) as { Username?: string; Secret?: string };
        if (parsed.Username && parsed.Secret) {
          resolve({ username: parsed.Username, password: parsed.Secret });
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
    proc.stdin.end(host);
  });
}

/** Resolve credentials for `host` from the ambient Docker credential chain:
 *  a per-registry credential helper, the global credential store, then the
 *  inline `auths` entry (base64 `user:password` or explicit fields). Returns
 *  null for anonymous access — the caller falls back to an anonymous token. */
export async function resolveDockerCredential(host: string): Promise<DockerCredential | null> {
  const config = await readDockerConfig();
  if (!config) return null;

  const helper = config.credHelpers?.[host];
  if (helper) return runCredentialHelper(helper, host);
  if (config.credsStore) return runCredentialHelper(config.credsStore, host);

  const entry = config.auths?.[host];
  if (entry?.auth) {
    const decoded = Buffer.from(entry.auth, "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon > 0) {
      return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
    }
  }
  if (entry?.username && entry?.password) {
    return { username: entry.username, password: entry.password };
  }
  return null;
}
