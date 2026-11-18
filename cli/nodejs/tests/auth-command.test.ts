import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import yargs from "yargs";

import { authCommand, loginCommand, logoutCommand, runAuthLogin, runAuthLogout, runAuthStatus } from "../src/commands/auth.js";
import { runSharesList } from "../src/commands/shares.js";
import { Output, installOutput } from "../src/output.js";
import { defaultCliServices, signInCommand, type CliServices } from "../src/share/cli-services.js";
import { SignInError } from "../src/sign-in/sign-in-error.js";
import { RunnerSignIn, type SignInStatus } from "../src/sign-in/runner-sign-in.js";
import { FakeRunner, runnerIdentity } from "./__fixtures__/share/fake-runner.js";
import { FakeAccounts } from "./__fixtures__/sign-in/fake-accounts.js";

const LIMITS = { maxPerOwner: 10, maxConnectedPerOwner: 3, retentionSeconds: 604800 };
const CLOUD = "https://cloud.acme.test/api";

let directory: string;
let accounts: FakeAccounts;
let runner: FakeRunner;
let stdout: string[];
let stderr: string[];
let restoreOutput: () => void;
const savedEnv = new Map<string, string | undefined>();

function captureOutput(format: "text" | "json"): void {
  restoreOutput?.();
  stdout = [];
  stderr = [];
  restoreOutput = installOutput(
    new Output({ format, stdout: { write: (c: string) => stdout.push(c) }, stderr: { write: (c: string) => stderr.push(c) }, env: {} }),
  );
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "telo-auth-"));
  accounts = await FakeAccounts.start();
  runner = await FakeRunner.start({
    shares: LIMITS,
    identity: (url) => runnerIdentity(url, accounts.url),
    respond: (request) => (request.method === "GET" && request.url === "/v1/shares" ? { status: 200, body: { shares: [] } } : undefined),
  });
  captureOutput("text");
  for (const [name, value] of Object.entries({ TELO_ACCOUNTS_URL: accounts.url, TELO_CLOUD_API_URL: CLOUD, TELO_RUNNER_URL: runner.url })) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  process.exitCode = undefined;
});

afterEach(async () => {
  restoreOutput();
  for (const [name, value] of savedEnv) value === undefined ? delete process.env[name] : (process.env[name] = value);
  savedEnv.clear();
  await accounts.close();
  await runner.close();
  fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** Services over the test's store whose browser follows the authorization redirect. */
function services(): CliServices {
  const env = { TELO_ACCOUNTS_URL: accounts.url, TELO_CLOUD_API_URL: CLOUD, DISPLAY: ":0" };
  const signIn = new RunnerSignIn({
    env,
    directory,
    signInCommand: (url) => signInCommand(url, process.env),
    openBrowser: (url) => void fetch(url).then((response) => response.text()),
  });
  return { ...defaultCliServices(env), signIn, credentials: signIn };
}

const stderrText = () => stderr.join("");
const json = (): SignInStatus => JSON.parse(stdout.join("")) as SignInStatus;

describe("telo auth", () => {
  it("signs in through the browser and says who and what the sign-in covers", async () => {
    const all = services();
    await runAuthLogin({}, all);
    expect(stderrText()).toMatch(new RegExp(`Opening your browser to sign in to ${accounts.url}\\. If it does not open, visit:\\n  ${accounts.url}/oauth2/authorize\\?`));
    expect(stderrText()).toContain(`Signed in to ${accounts.url} as alice\n`);
    expect(process.exitCode).toBeUndefined();

    captureOutput("text");
    await runAuthStatus(all);
    expect(stderrText()).toBe(`Signed in to ${accounts.url} as alice\n  cloud ${CLOUD}\n  runner ${runner.url}\n`);
    expect(process.exitCode).toBeUndefined();
  });

  it("signs in with a device code on request, and answers the status document under -o json", async () => {
    captureOutput("json");
    const login = runAuthLogin({ deviceCode: true }, services());
    const code = await until(() => /enter the code (ABCD-\d+)/.exec(stderrText())?.[1]);
    accounts.approveDevice(code);
    await login;

    expect(stderrText()).toContain(`open ${accounts.url}/device and enter the code ${code}`);
    expect(accounts.authorizations).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: true,
      signedIn: true,
      issuer: accounts.url,
      account: { sub: "usr_alice", username: "alice" },
      resources: { cloud: CLOUD, runner: runner.url },
      verified: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("names the account by its subject when it has no username", async () => {
    await accounts.close();
    accounts = await FakeAccounts.start({ account: { sub: "usr_bob" } });
    process.env.TELO_ACCOUNTS_URL = accounts.url;
    await runner.close();
    runner = await FakeRunner.start({ shares: LIMITS, identity: (url) => runnerIdentity(url, accounts.url) });
    process.env.TELO_RUNNER_URL = runner.url;
    await runAuthLogin({}, services());
    expect(stderrText()).toContain(`Signed in to ${accounts.url} as usr_bob\n`);
  });

  it("exits 1 for a login that fails, with ERR_SIGN_IN_FAILED", async () => {
    const all = services();
    accounts.rotateNonce();
    await accounts.close();
    await runAuthLogin({}, all);
    expect(stderrText()).toMatch(/error ERR_SIGN_IN_FAILED: /);
    expect(process.exitCode).toBe(1);
  });

  it("writes the status document, with the problem, for a failed login and a failed logout under -o json", async () => {
    const all = services();
    captureOutput("json");
    accounts.rotateNonce();
    await runAuthLogin({ deviceCode: true }, { ...all, signIn: Object.assign(Object.create(all.signIn), { login: async () => { throw new SignInError("ERR_SIGN_IN_FAILED", "denied"); } }) });
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: false,
      signedIn: false,
      issuer: accounts.url,
      account: null,
      resources: null,
      verified: false,
      problem: { code: "ERR_SIGN_IN_FAILED", message: "denied" },
    });

    await all.signIn.login({ runnerUrl: runner.url, signal: new AbortController().signal, onEvent: () => {} });
    captureOutput("json");
    await runAuthLogout({ ...all, signIn: Object.assign(Object.create(all.signIn), { logout: async () => { throw new SignInError(undefined, "store locked"); } }) });
    expect(JSON.parse(stdout.join(""))).toEqual({ ok: false, signedIn: true, issuer: accounts.url, problem: { code: null, message: "store locked" } });
  });

  it("exits 1 from status when signed out or when accounts cannot confirm it, and 0 when it does", async () => {
    const all = services();
    await runAuthStatus(all);
    expect(stderrText()).toBe(`Not signed in to ${accounts.url}\n  run: telo auth login\n`);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    captureOutput("json");
    await runAuthStatus(all);
    expect(json()).toEqual({ ok: false, signedIn: false, issuer: accounts.url, account: null, resources: null, verified: false });

    process.exitCode = undefined;
    captureOutput("text");
    accounts.accessTokenTtl = 10;
    await runAuthLogin({}, all);
    captureOutput("text");
    process.exitCode = undefined;
    await accounts.close();
    await runAuthStatus(all);
    expect(stderrText()).toContain(`Signed in to ${accounts.url} as alice`);
    expect(stderrText()).toMatch(/error: could not reach /);
    expect(process.exitCode).toBe(1);
  });

  it("signs out, says so when there is nothing to sign out of, and exits 1 only when the revoke failed", async () => {
    const all = services();
    await runAuthLogin({}, all);
    captureOutput("text");
    await runAuthLogout(all);
    expect(stderrText()).toBe(`Signed out of ${accounts.url} (was alice)\n`);
    expect(accounts.grants[0]!.revoked).toBe(true);

    captureOutput("text");
    await runAuthLogout(all);
    expect(stderrText()).toBe(`Not signed in to ${accounts.url}; nothing to sign out of.\n`);
    expect(process.exitCode).toBeUndefined();

    await runAuthLogin({}, all);
    accounts.revokeStatus = 503;
    captureOutput("text");
    await runAuthLogout(all);
    expect(stderrText()).toContain("error ERR_SIGN_IN_REVOKE_FAILED: signed out on this machine");
    expect(process.exitCode).toBe(1);
  });

  it("warns, and still succeeds, when a second login cannot revoke the first", async () => {
    const all = services();
    await runAuthLogin({}, all);
    accounts.revokeStatus = 503;
    captureOutput("json");
    await runAuthLogin({}, all);
    expect(stderrText()).toContain("warning ERR_SIGN_IN_REVOKE_FAILED: signed in, but the earlier sign-in");
    expect(json()).toMatchObject({ ok: true, signedIn: true, problem: { code: "ERR_SIGN_IN_REVOKE_FAILED" } });
    expect(process.exitCode).toBeUndefined();
  });

  it("is one command under telo auth login / logout and telo login / logout", async () => {
    const calls: string[] = [];
    const signIn = {
      issuer: "https://accounts.acme.test",
      login: async (options: { runnerUrl: string; deviceCode?: boolean }) => {
        calls.push(`login ${options.runnerUrl} ${options.deviceCode ?? false}`);
        return { ok: true, signedIn: true, issuer: "https://accounts.acme.test", account: { sub: "s", username: null }, resources: null, verified: true };
      },
      logout: async () => {
        calls.push("logout");
        return { outcome: "not-signed-in", issuer: "https://accounts.acme.test" };
      },
    } as unknown as RunnerSignIn;
    const fake = { ...defaultCliServices(), signIn } as CliServices;
    for (const args of [["auth", "login", "--runner", "https://r.acme.test/", "--device-code"], ["login", "--runner", "https://r.acme.test/", "--device-code"], ["auth", "logout"], ["logout"]]) {
      await authCommand(fake)(loginCommand(fake)(logoutCommand(fake)(yargs(args)))).parseAsync();
      calls.push("|");
    }
    expect(calls).toEqual([
      "login https://r.acme.test true", "|",
      "login https://r.acme.test true", "|",
      "logout", "|",
      "logout", "|",
    ]);
  });
});

describe("the sign-in offered at a terminal", () => {
  const terminal = (answer: string, tty = true) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: tty });
    stdin.write(answer);
    return { stdin: stdin as unknown as NodeJS.ReadStream, stderr: { isTTY: tty } };
  };

  it("signs in on Enter and carries the command on", async () => {
    await runSharesList({ runner: runner.url }, services(), terminal("\n"));
    expect(stderrText()).toContain("Sign in to Telo now? [Y/n] ");
    expect(stderrText()).toContain(`Signed in to ${accounts.url} as alice\n`);
    expect(runner.requests.some((request) => request.url === "/v1/shares" && request.headers.authorization?.startsWith("DPoP "))).toBe(true);
    expect(stdout.join("")).toContain("ID");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses with the hint on no, without --no-input or without a terminal, and never starts a login", async () => {
    const hint = `ERR_RUNNER_SIGN_IN_REQUIRED: sharing needs a sign-in to ${runner.url}\n  run: telo auth login\n`;

    await runSharesList({ runner: runner.url }, services(), terminal("n\n"));
    expect(stderrText()).toContain("Sign in to Telo now? [Y/n] ");
    expect(stderrText()).toContain(hint);
    expect(process.exitCode).toBe(1);

    for (const [argv, streams] of [[{ input: false }, terminal("\n")], [{}, terminal("\n", false)]] as const) {
      captureOutput("text");
      process.exitCode = undefined;
      await runSharesList({ runner: runner.url, ...argv }, services(), streams);
      expect(stderrText()).not.toContain("Sign in to Telo now?");
      expect(stderrText()).toContain(hint);
      expect(process.exitCode).toBe(1);
    }
    expect(accounts.authorizations).toEqual([]);
  });

  it("exits 1 with ERR_SIGN_IN_FAILED when the login it was offered fails", async () => {
    const all = services();
    all.signIn = new RunnerSignIn({
      env: { TELO_ACCOUNTS_URL: accounts.url, DISPLAY: ":0" },
      directory,
      signInCommand: () => "telo auth login",
      openBrowser: (_url, onFailure) => onFailure("no browser"),
      fetch: async (input, init) => {
        if (String(input).endsWith("/oauth2/device/code")) return new Response(JSON.stringify({ error: "access_denied" }), { status: 400 });
        return fetch(input, init);
      },
    });
    await runSharesList({ runner: runner.url }, all, terminal("y\n"));
    expect(stderrText()).toMatch(/error ERR_SIGN_IN_FAILED: /);
    expect(process.exitCode).toBe(1);
  });
});

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting");
}
