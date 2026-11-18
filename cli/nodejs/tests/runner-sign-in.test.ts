import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSharesList } from "../src/commands/shares.js";
import { Output, installOutput } from "../src/output.js";
import { defaultCliServices, signInCommand } from "../src/share/cli-services.js";
import { takeLockFile } from "../src/lock-file.js";
import { CredentialsFile, CREDENTIALS_FILE, CREDENTIALS_VERSION, type CredentialsDocument, type SignInRecord } from "../src/sign-in/credentials-file.js";
import { runnerIdentityMismatch } from "../src/sign-in/runner-identity.js";
import { prefersDeviceCode, RunnerSignIn, type SignInCredentialAnswer } from "../src/sign-in/runner-sign-in.js";
import type { SignInEvent } from "../src/sign-in/authorization-flows.js";
import { FakeRunner, runnerIdentity } from "./__fixtures__/share/fake-runner.js";
import { FakeAccounts, verifyProof } from "./__fixtures__/sign-in/fake-accounts.js";

const LIMITS = { maxPerOwner: 10, maxConnectedPerOwner: 3, retentionSeconds: 604800 };
const CLOUD = "https://cloud.acme.test/api";

let directory: string;
let accounts: FakeAccounts;
let runner: FakeRunner;
let stderr: string[];
let restoreOutput: () => void;
const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "telo-sign-in-"));
  accounts = await FakeAccounts.start();
  runner = await FakeRunner.start({
    shares: LIMITS,
    identity: (url) => runnerIdentity(url, accounts.url),
    respond: (request) => (request.method === "GET" && request.url === "/v1/shares" ? { status: 200, body: { shares: [] } } : undefined),
  });
  stderr = [];
  restoreOutput = installOutput(
    new Output({ format: "text", stdout: { write: () => true }, stderr: { write: (chunk: string) => stderr.push(chunk) }, env: {} }),
  );
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

const env = (): NodeJS.ProcessEnv => ({ TELO_ACCOUNTS_URL: accounts.url, TELO_CLOUD_API_URL: CLOUD, DISPLAY: ":0" });

/** A sign-in engine over the test's store, whose browser follows the authorization redirect. */
function engine(options: { failBrowser?: boolean } = {}): RunnerSignIn {
  const environment = env();
  return new RunnerSignIn({
    env: environment,
    directory,
    signInCommand: (url) => signInCommand(url, environment),
    openBrowser: (url, onFailure) => {
      if (options.failBrowser) return onFailure("xdg-open exited with code 3");
      void fetch(url).then((response) => response.text());
    },
  });
}

const signal = () => new AbortController().signal;
const readStore = (): CredentialsDocument => JSON.parse(fs.readFileSync(path.join(directory, CREDENTIALS_FILE), "utf8")) as CredentialsDocument;
const ask = (signIn: RunnerSignIn, minLifetimeMs = 30_000) => signIn.credential({ runnerUrl: runner.url, minLifetimeMs, signal: signal() });

async function signedIn(signIn = engine()): Promise<RunnerSignIn> {
  await signIn.login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} });
  return signIn;
}

function setProcessEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
}

describe("telo's sign-in to accounts", () => {
  it("signs in through the browser with one grant naming the Cloud API and the runner, kept in a 0600 file", async () => {
    const events: SignInEvent[] = [];
    const status = await engine().login({ runnerUrl: runner.url, signal: signal(), onEvent: (event) => events.push(event) });

    expect(status).toEqual({
      ok: true,
      signedIn: true,
      issuer: accounts.url,
      account: { sub: "usr_alice", username: "alice" },
      resources: { cloud: CLOUD, runner: runner.url },
      verified: true,
    });
    expect(events.map((event) => event.type)).toEqual(["browser"]);
    const [authorization] = accounts.authorizations;
    expect(authorization).toMatchObject({
      client_id: "telo-cli",
      response_type: "code",
      code_challenge_method: "S256",
      resource: [CLOUD, runner.url],
      dpop_jkt: accounts.grants[0]!.jkt,
    });
    expect(String(authorization!.redirect_uri)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(String(authorization!.scope).split(" ")).toContain("offline_access");
    expect(String(authorization!.scope).split(" ")).toContain("runner:sessions");
    expect(String(authorization!.scope).split(" ")).toContain("email");
    expect(accounts.nonceChallenges).toBe(1);
    expect(accounts.revocations).toEqual([]);

    const record = readStore().signIns[accounts.url]!;
    expect(readStore().version).toBe(1);
    expect(record).toMatchObject({ clientId: "telo-cli", refreshToken: accounts.grants[0]!.refreshToken, resources: { cloud: CLOUD, runner: runner.url } });
    expect(Object.keys(record.accessTokens)).toEqual([runner.url]);
    expect(Object.keys(record.account)).toEqual(["sub", "username"]);
    expect(fs.readFileSync(path.join(directory, CREDENTIALS_FILE), "utf8")).not.toMatch(/email|"name"/);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(directory, CREDENTIALS_FILE)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps the subject alone when the ID token names no preferred_username", async () => {
    await accounts.close();
    accounts = await FakeAccounts.start({ account: { sub: "usr_bob" } });
    await runner.close();
    runner = await FakeRunner.start({ shares: LIMITS, identity: (url) => runnerIdentity(url, accounts.url) });
    const status = await engine().login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} });
    expect(status.account).toEqual({ sub: "usr_bob", username: null });
  });

  it("falls back to a device code, bound to the key, when the browser cannot be opened", async () => {
    const events: SignInEvent[] = [];
    await engine({ failBrowser: true }).login({
      runnerUrl: runner.url,
      signal: signal(),
      onEvent: (event) => {
        events.push(event);
        if (event.type === "device-code") accounts.approveDevice(event.userCode);
      },
    });
    expect(events.map((event) => event.type)).toEqual(["browser", "browser-failed", "device-code"]);
    expect(accounts.deviceAuthorizations[0]).toMatchObject({ client_id: "telo-cli", resource: [CLOUD, runner.url], dpop_jkt: accounts.grants[0]!.jkt });
    expect(readStore().signIns[accounts.url]!.refreshToken).toBe(accounts.grants[0]!.refreshToken);
  });

  it("chooses a device code over SSH and on Linux without a display", () => {
    expect(prefersDeviceCode({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22", DISPLAY: ":0" }, "darwin")).toBe(true);
    expect(prefersDeviceCode({ SSH_TTY: "/dev/pts/1" }, "win32")).toBe(true);
    expect(prefersDeviceCode({}, "linux")).toBe(true);
    expect(prefersDeviceCode({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
    expect(prefersDeviceCode({ BROWSER: "/usr/bin/wslview" }, "linux")).toBe(false);
    expect(prefersDeviceCode({}, "darwin")).toBe(false);
  });

  it("refuses to sign in for a runner whose advertised identity names another, before accounts is asked", async () => {
    await runner.close();
    runner = await FakeRunner.start({ identity: (url) => runnerIdentity(url.replace("127.0.0.1", "localhost"), accounts.url) });
    const login = engine().login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} });
    await expect(login).rejects.toMatchObject({
      code: "ERR_RUNNER_IDENTITY_MISMATCH",
      message: `${runner.url} identifies as ${runner.url.replace("127.0.0.1", "localhost")}; a sign-in is sent only to the runner it names`,
    });
    expect(accounts.authorizations).toEqual([]);
  });

  it("words each way a runner's identity can disagree", () => {
    const url = "https://runner.acme.test";
    const issuer = "https://accounts.acme.test";
    expect(runnerIdentityMismatch(url, runnerIdentity("HTTPS://Runner.Acme.Test:443/", issuer), issuer)).toBeUndefined();
    expect(runnerIdentityMismatch(url, undefined, issuer)).toBe(`${url} advertises no identity`);
    expect(runnerIdentityMismatch(url, runnerIdentity("https://other.acme.test", issuer), issuer)).toBe(
      `${url} identifies as https://other.acme.test; a sign-in is sent only to the runner it names`,
    );
    expect(runnerIdentityMismatch(url, runnerIdentity(url, "https://id.other.test"), issuer)).toBe(
      `${url} accepts sign-ins from https://id.other.test, not ${issuer} (TELO_ACCOUNTS_URL)`,
    );
    expect(runnerIdentityMismatch(url, { ...runnerIdentity(url, issuer), dpop_signing_alg_values_supported: ["EdDSA"] }, issuer)).toBe(
      `${url} accepts no DPoP key telo signs with (ES256)`,
    );
  });

  it("gives telo shares a DPoP-bound runner token, every request proved by the stored key", async () => {
    const signIn = await signedIn();
    // Built before the environment names the issuer, as the composition root is before an .env file applies.
    const services = { ...defaultCliServices(), credentials: signIn };
    setProcessEnv({ TELO_ACCOUNTS_URL: accounts.url });
    await runSharesList({ runner: runner.url }, services);
    await runSharesList({ runner: runner.url }, services);

    const token = readStore().signIns[accounts.url]!.accessTokens[runner.url]!.token;
    const listed = runner.requests.filter((request) => request.url === "/v1/shares");
    expect(listed).toHaveLength(2);
    const proofs = listed.map((request) => {
      expect(request.headers.authorization).toBe(`DPoP ${token}`);
      return verifyProof(String(request.headers.dpop), `${runner.url}/v1/shares`, token);
    });
    expect(proofs.map((proof) => proof?.jkt)).toEqual([accounts.grants[0]!.jkt, accounts.grants[0]!.jkt]);
    expect(proofs[0]!.payload.jti).not.toBe(proofs[1]!.payload.jti);
    expect(process.exitCode).toBeUndefined();
  });

  it("answers a runner the grant does not cover with the sign-in it would need", async () => {
    const signIn = await signedIn();
    const other = await FakeRunner.start({ shares: LIMITS, identity: (url) => runnerIdentity(url, accounts.url) });
    setProcessEnv({ TELO_ACCOUNTS_URL: accounts.url });
    await runSharesList({ runner: other.url }, { ...defaultCliServices(), credentials: signIn });
    await other.close();
    expect(stderr.join("")).toContain(
      `ERR_RUNNER_SIGN_IN_REQUIRED: the sign-in at ${accounts.url} covers ${runner.url}, not ${other.url}\n  run: telo auth login --runner ${other.url}\n`,
    );
    expect(other.requests.map((request) => request.url)).toEqual(["/v1/capabilities"]);
  });

  it("leaves the old file or the new one when a write is killed", async () => {
    const script = path.join(directory, "writer.mjs");
    await build({
      entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/sign-in/credentials-writer.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: script,
      logLevel: "silent",
    });
    const store = path.join(directory, "store");
    for (let round = 0; round < 8; round++) {
      const child = spawn(process.execPath, [script, store], { stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 5 + round * 17));
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      const stored = JSON.parse(fs.readFileSync(path.join(store, CREDENTIALS_FILE), "utf8")) as CredentialsDocument;
      expect(["even", "odd"]).toContain(stored.signIns["https://accounts.acme.test"]!.refreshToken);
    }
  }, 30_000);

  it("refreshes once for ten processes asking past expiry, and every one gets the token", async () => {
    accounts.accessTokenTtl = 10;
    await signedIn();
    accounts.accessTokenTtl = 600;
    accounts.refreshDelayMs = 200;
    const answers = await Promise.all(Array.from({ length: 10 }, () => ask(engine())));

    expect(accounts.refreshes).toBe(1);
    expect(accounts.replays).toBe(0);
    const token = readStore().signIns[accounts.url]!.accessTokens[runner.url]!.token;
    expect(answers.map((answer) => (answer.outcome === "credential" ? answer.credential.accessToken : answer.outcome))).toEqual(Array(10).fill(token));
    expect(readStore().signIns[accounts.url]!.refreshToken).toBe(accounts.grants[0]!.refreshToken);
    expect(fs.existsSync(path.join(directory, `${CREDENTIALS_FILE}.lock`))).toBe(false);
  });

  it("presents a refresh whose answer was lost once more, inside the window, and keeps the grant", async () => {
    accounts.accessTokenTtl = 10;
    await signedIn();
    accounts.accessTokenTtl = 600;
    accounts.dropRefreshAnswers = 1;
    accounts.rotateNonce();
    const answer = await ask(engine());

    expect(answer.outcome).toBe("credential");
    expect(accounts.refreshes).toBe(1);
    expect(accounts.replays).toBe(1);
    expect(accounts.grants[0]!.revoked).toBe(false);
    expect(readStore().signIns[accounts.url]!.refreshToken).toBe(accounts.grants[0]!.refreshToken);
  });

  it("forgets a grant accounts answers invalid_grant for, and asks for a sign-in", async () => {
    accounts.accessTokenTtl = 10;
    await signedIn();
    accounts.revokeGrant(accounts.grants[0]!);
    const answer = await ask(engine());

    expect(answer).toMatchObject({ outcome: "sign-in-required", runnerUrl: runner.url, command: `telo auth login --runner ${runner.url}` });
    expect(readStore().signIns).toEqual({});
  });

  it("picks up a sign-in another process wrote, on the next call", async () => {
    const running = engine();
    const before: SignInCredentialAnswer = await ask(running);
    expect(before.outcome).toBe("sign-in-required");
    await signedIn(engine());
    const after = await ask(running);
    expect(after.outcome).toBe("credential");
  });

  it("confirms the sign-in with accounts, and reports a revoked one as signed out", async () => {
    const signIn = await signedIn();
    const refreshesBefore = accounts.refreshes;
    expect(await signIn.status({ signal: signal() })).toMatchObject({ ok: true, signedIn: true, verified: true, account: { sub: "usr_alice", username: "alice" } });
    expect(accounts.refreshes).toBe(refreshesBefore + 1);

    accounts.revokeGrant(accounts.grants[0]!);
    const status = await signIn.status({ signal: signal() });
    expect(status).toMatchObject({ ok: false, signedIn: false, account: null, verified: false, problem: { code: "ERR_RUNNER_SIGN_IN_REQUIRED" } });
    expect(readStore().signIns).toEqual({});
  });

  it("signs out by revoking the refresh token, then forgetting it", async () => {
    const signIn = await signedIn();
    const refreshToken = readStore().signIns[accounts.url]!.refreshToken;
    expect(await signIn.logout({ signal: signal() })).toMatchObject({ outcome: "signed-out", account: { sub: "usr_alice" } });
    expect(accounts.revocations).toEqual([refreshToken]);
    expect(accounts.grants[0]!.revoked).toBe(true);
    expect(readStore().signIns).toEqual({});
    expect(await signIn.logout({ signal: signal() })).toEqual({ outcome: "not-signed-in", issuer: accounts.url });
  });

  it("forgets the sign-in when accounts cannot revoke it, and says the grant is still live", async () => {
    const signIn = await signedIn();
    accounts.revokeStatus = 503;
    const result = await signIn.logout({ signal: signal() });
    expect(result.outcome).toBe("revoke-failed");
    if (result.outcome !== "revoke-failed") return;
    expect(result.error.code).toBe("ERR_SIGN_IN_REVOKE_FAILED");
    expect(result.error.message).toBe(
      `signed out on this machine, but the sign-in at ${accounts.url} could not be revoked (${accounts.url}/oauth2/revoke answered 503 temporarily_unavailable); it stays valid until revoked under Apps and devices at ${accounts.url}`,
    );
    expect(readStore().signIns).toEqual({});
  });

  it("revokes the refresh token a new login replaces, as the file holds it then", async () => {
    accounts.accessTokenTtl = 10;
    const signIn = await signedIn();
    const first = readStore().signIns[accounts.url]!.refreshToken;
    await ask(signIn);
    const rotated = readStore().signIns[accounts.url]!.refreshToken;
    expect(rotated).not.toBe(first);

    const status = await signIn.login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} });

    expect(status.problem).toBeUndefined();
    expect(accounts.revocations).toEqual([rotated]);
    expect(accounts.grants.map((grant) => grant.revoked)).toEqual([true, false]);
    expect(readStore().signIns[accounts.url]!.refreshToken).toBe(accounts.grants[1]!.refreshToken);
  });

  it("signs in anyway, with a warning, when the sign-in it replaced cannot be revoked", async () => {
    const signIn = await signedIn();
    accounts.revokeStatus = 503;
    const status = await signIn.login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} });

    expect(status).toMatchObject({ ok: true, signedIn: true, verified: true, problem: { code: "ERR_SIGN_IN_REVOKE_FAILED" } });
    expect(status.problem!.message).toBe(
      `signed in, but the earlier sign-in at ${accounts.url} could not be revoked (${accounts.url}/oauth2/revoke answered 503 temporarily_unavailable); it stays valid until revoked under Apps and devices at ${accounts.url}`,
    );
    expect(readStore().signIns[accounts.url]!.refreshToken).toBe(accounts.grants[1]!.refreshToken);
  });

  it("keeps the rotated refresh token of a refresh whose caller gave up, so the next one is not a reuse", async () => {
    accounts.accessTokenTtl = 10;
    const signIn = await signedIn();
    const before = readStore().signIns[accounts.url]!.refreshToken;
    accounts.accessTokenTtl = 600;
    accounts.refreshDelayMs = 150;
    accounts.reuseWindowMs = 0;
    const gaveUp = new AbortController();
    const asked = signIn.credential({ runnerUrl: runner.url, minLifetimeMs: 30_000, signal: gaveUp.signal });
    setTimeout(() => gaveUp.abort(new Error("gave up")), 40);
    await expect(asked).rejects.toThrow("gave up");

    for (let attempt = 0; attempt < 200 && readStore().signIns[accounts.url]!.refreshToken === before; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(readStore().signIns[accounts.url]!.refreshToken).toBe(accounts.grants[0]!.refreshToken);
    expect(readStore().signIns[accounts.url]!.refreshToken).not.toBe(before);

    accounts.refreshDelayMs = 0;
    accounts.accessTokenTtl = 10;
    await ask(signIn);
    accounts.accessTokenTtl = 600;
    expect((await ask(signIn)).outcome).toBe("credential");
    expect(accounts.grants[0]!.revoked).toBe(false);
  });

  it("keeps the sign-in when accounts refuses a refresh for good without refusing the grant", async () => {
    accounts.accessTokenTtl = 10;
    const signIn = await signedIn();
    accounts.refreshError = "invalid_target";
    const answer = await ask(signIn);

    expect(answer).toMatchObject({ outcome: "sign-in-required", message: `${accounts.url} refused to refresh the sign-in: invalid_target` });
    expect(readStore().signIns[accounts.url]).toBeDefined();
  });

  it("reads TELO_ACCOUNTS_URL from the environment at each call, not once at construction", async () => {
    const environment: NodeJS.ProcessEnv = { TELO_CLOUD_API_URL: CLOUD, DISPLAY: ":0" };
    const signIn = new RunnerSignIn({
      env: environment,
      directory,
      signInCommand: (url) => signInCommand(url, environment),
      openBrowser: (url) => void fetch(url).then((response) => response.text()),
    });
    environment.TELO_ACCOUNTS_URL = accounts.url;
    expect(signIn.issuer).toBe(accounts.url);
    await signIn.login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} });
    expect(Object.keys(readStore().signIns)).toEqual([accounts.url]);
  });

  it("sends the runner's own spelling of its resource, as advertised", async () => {
    await runner.close();
    runner = await FakeRunner.start({ shares: LIMITS, identity: (url) => runnerIdentity(`${url}/`, accounts.url) });
    await engine().login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} });
    expect(accounts.authorizations[0]!.resource).toEqual([CLOUD, `${runner.url}/`]);
    expect(readStore().signIns[accounts.url]!.resources.runner).toBe(`${runner.url}/`);
    expect((await ask(engine())).outcome).toBe("credential");
  });

  it("refuses a login before asking accounts when the store cannot be read", async () => {
    fs.writeFileSync(path.join(directory, CREDENTIALS_FILE), "{ not json");
    await expect(engine().login({ runnerUrl: runner.url, signal: signal(), onEvent: () => {} })).rejects.toThrow(/not valid JSON/);
    expect(accounts.authorizations).toEqual([]);
  });

  it("revokes a grant it could not store, and says so", async () => {
    const login = engine().login({
      runnerUrl: runner.url,
      signal: signal(),
      onEvent: () => fs.writeFileSync(path.join(directory, CREDENTIALS_FILE), "{ not json"),
    });
    await expect(login).rejects.toMatchObject({
      code: "ERR_SIGN_IN_FAILED",
      message: expect.stringMatching(/not valid JSON.*; the new sign-in at .* was revoked again$/),
    });
    expect(accounts.grants.map((grant) => grant.revoked)).toEqual([true]);
    expect(accounts.revocations).toEqual([accounts.grants[0]!.refreshToken]);
  });

  it("says where a grant it could neither store nor revoke stays valid", async () => {
    accounts.revokeStatus = 503;
    const login = engine().login({
      runnerUrl: runner.url,
      signal: signal(),
      onEvent: () => fs.writeFileSync(path.join(directory, CREDENTIALS_FILE), "{ not json"),
    });
    await expect(login).rejects.toMatchObject({
      code: "ERR_SIGN_IN_FAILED",
      message: expect.stringContaining(`could not be revoked (${accounts.url}/oauth2/revoke answered 503 temporarily_unavailable); it stays valid until revoked under Apps and devices at ${accounts.url}`),
    });
  });

  it("keeps polling a device code when a poll never left this machine", async () => {
    let refused = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/oauth2/token") && refused++ === 0) {
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      }
      return fetch(input, init);
    };
    const environment = env();
    const signIn = new RunnerSignIn({ env: environment, directory, signInCommand: (url) => signInCommand(url, environment), fetch: flaky });
    const status = await signIn.login({
      runnerUrl: runner.url,
      deviceCode: true,
      signal: signal(),
      onEvent: (event) => {
        if (event.type === "device-code") accounts.approveDevice(event.userCode);
      },
    });
    expect(status.signedIn).toBe(true);
    expect(refused).toBeGreaterThan(1);
  });

  it("forgets the sign-in and says so when a logout is cancelled before accounts answers", async () => {
    await signedIn();
    const cancel = new AbortController();
    const environment = env();
    const cancelling: typeof fetch = (input, init) => {
      if (String(input).endsWith("/oauth2/revoke")) cancel.abort(new Error("cancelled"));
      return fetch(input, init);
    };
    const signIn = new RunnerSignIn({ env: environment, directory, signInCommand: (url) => signInCommand(url, environment), fetch: cancelling });
    const result = await signIn.logout({ signal: cancel.signal });

    expect(result.outcome).toBe("revoke-failed");
    if (result.outcome !== "revoke-failed") return;
    expect(result.error.message).toContain("cancelled before accounts answered");
    expect(readStore().signIns).toEqual({});
  });

  it("lets exactly one of two processes racing a stale lock take it", async () => {
    for (let round = 0; round < 15; round++) {
      const lock = path.join(directory, `race-${round}.lock`);
      fs.writeFileSync(lock, "9999 dead\n");
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      const outcomes = await Promise.allSettled([
        takeLockFile(lock, { staleMs: 60_000, waitMs: 60 }),
        takeLockFile(lock, { staleMs: 60_000, waitMs: 60 }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      for (const outcome of outcomes) if (outcome.status === "fulfilled") await outcome.value.release();
    }
  });

  it("removes a crashed writer's temporary file and a crashed takeover's stale file at the next write", async () => {
    accounts.accessTokenTtl = 10;
    const signIn = await signedIn();
    const tmp = path.join(directory, `${CREDENTIALS_FILE}.4242.dead.tmp`);
    const stale = path.join(directory, `${CREDENTIALS_FILE}.lock.4242.dead.stale`);
    const other = path.join(directory, `${CREDENTIALS_FILE}.bak`);
    for (const file of [tmp, stale, other]) fs.writeFileSync(file, "x");

    accounts.accessTokenTtl = 600;
    expect((await ask(signIn)).outcome).toBe("credential");

    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("fails a write made after the lock was taken over, leaving the newer file", async () => {
    const file = new CredentialsFile(path.join(directory, "store"));
    await file.ensureDirectory();
    const record = (refreshToken: string): SignInRecord => ({
      clientId: "telo-cli",
      dpopKey: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
      refreshToken,
      resources: { cloud: CLOUD, runner: "https://runner.acme.test" },
      account: { sub: "usr_alice", username: null },
      accessTokens: {},
      signedInAt: new Date(0).toISOString(),
    });
    const document = (refreshToken: string): CredentialsDocument => ({ version: CREDENTIALS_VERSION, signIns: { [accounts.url]: record(refreshToken) } });

    const slow = await takeLockFile(file.lock, { staleMs: 60_000, waitMs: 100 });
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file.lock, old, old);
    const later = await takeLockFile(file.lock, { staleMs: 60_000, waitMs: 100 });
    await file.write(document("newer"), later);

    await expect(file.write(document("older"), slow)).rejects.toThrow(/was taken over/);
    expect((await file.read()).signIns[accounts.url]!.refreshToken).toBe("newer");
    expect(fs.readdirSync(file.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await slow.release();
    expect(fs.existsSync(file.lock)).toBe(true);
    await later.release();
    expect(fs.existsSync(file.lock)).toBe(false);
  });
});
