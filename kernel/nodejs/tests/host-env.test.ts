import { describe, expect, it, vi } from "vitest";
import { createLockedEnv, hostEnv, lockControllerEnv } from "../src/host-env.js";

describe("createLockedEnv — the controller process.env guardrail", () => {
  it("denies a declared binding even when the var is set, and warns once", () => {
    const warn = vi.fn();
    const env = createLockedEnv(
      { DATABASE_URL: "postgres://secret" },
      new Set(["DATABASE_URL"]),
      warn,
    );

    expect(env.DATABASE_URL).toBeUndefined();
    void env.DATABASE_URL;
    void env.DATABASE_URL;

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("DATABASE_URL");
  });

  it("hides denied keys from `in` and enumeration", () => {
    const env = createLockedEnv({ STRIPE_KEY: "sk_live" }, new Set(["STRIPE_KEY"]), () => {});

    expect("STRIPE_KEY" in env).toBe(false);
    expect(Object.keys(env)).toEqual([]);
    expect(Object.entries(env)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(env, "STRIPE_KEY")).toBeUndefined();
  });

  it("passes every undeclared key through transparently — no hardcoded vendor allowlist", () => {
    const warn = vi.fn();
    const env = createLockedEnv(
      {
        NODE_ENV: "production",
        AWS_PROFILE: "default",
        AWS_ACCESS_KEY_ID: "AKIA...",
        BUN_X: "1",
        DATABASE_URL: "postgres://secret",
      },
      new Set(["DATABASE_URL"]),
      warn,
    );

    // Anything the manifest did not bind passes through — including an SDK's own
    // AWS config and even AWS credentials (the app takes those via a declared
    // secret, so reading the raw var was never the sanctioned path anyway).
    expect(env.NODE_ENV).toBe("production");
    expect(env.AWS_PROFILE).toBe("default");
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA...");
    expect(env.BUN_X).toBe("1");
    expect("AWS_PROFILE" in env).toBe(true);
    expect(Object.keys(env).sort()).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_PROFILE",
      "BUN_X",
      "NODE_ENV",
    ]);
    // ...but the one declared binding is denied, and only it warns.
    expect(env.DATABASE_URL).toBeUndefined();
    expect(warn.mock.calls.flat()).toEqual(["DATABASE_URL"]);
  });

  it("consults the denied set live — keys added after install take effect", () => {
    const denied = new Set<string>();
    const env = createLockedEnv({ LATE_SECRET: "shh" }, denied, () => {});

    expect(env.LATE_SECRET).toBe("shh"); // not yet denied
    denied.add("LATE_SECRET"); // a later kernel binds it
    expect(env.LATE_SECRET).toBeUndefined();
  });

  it("warns on a declared key even when unset; an undeclared unset key is silent", () => {
    const warn = vi.fn();
    const env = createLockedEnv({}, new Set(["DECLARED_BUT_UNSET"]), warn);

    expect(env.NODE_ENV).toBeUndefined(); // undeclared + unset → silent passthrough
    expect("NODE_ENV" in env).toBe(false);
    expect(env.DECLARED_BUT_UNSET).toBeUndefined(); // declared → reading it is a bypass
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("DECLARED_BUT_UNSET");
  });

  it("lets writes through to the backing environment", () => {
    const backing: NodeJS.ProcessEnv = {};
    const env = createLockedEnv(backing, new Set<string>(), () => {});

    env.SOME_FLAG = "on";

    expect(backing.SOME_FLAG).toBe("on");
  });
});

describe("hostEnv / lockControllerEnv", () => {
  it("hostEnv() exposes the real environment", () => {
    process.env.__HOST_ENV_PROBE = "yes";
    try {
      expect(hostEnv().__HOST_ENV_PROBE).toBe("yes");
    } finally {
      delete process.env.__HOST_ENV_PROBE;
    }
  });

  // Installs the process-global guardrail — kept last so the rest of this file's
  // tests run against an unlocked process.env. vitest isolates test files, so
  // the lock stays contained to this worker.
  it("denies declared keys on process.env, unions additively, and is idempotent", () => {
    process.env.DECLARED_SECRET = "leak";
    process.env.UNDECLARED = "fine";
    const warnFirst = vi.fn();
    const warnSecond = vi.fn();

    lockControllerEnv(["DECLARED_SECRET"], warnFirst);
    // A second kernel boots with its own binding: the install is a no-op but the
    // key unions into the live denied set, using the first warn sink.
    lockControllerEnv(["LATER_KEY"], warnSecond);
    process.env.LATER_KEY = "leak2";

    // Real values still readable through the captured snapshot...
    expect(hostEnv().DECLARED_SECRET).toBe("leak");
    // ...but denied through the global process.env.
    expect(process.env.DECLARED_SECRET).toBeUndefined();
    expect(process.env.LATER_KEY).toBeUndefined(); // unioned after install
    // Undeclared keys pass through untouched.
    expect(process.env.UNDECLARED).toBe("fine");

    expect(warnFirst.mock.calls.flat().sort()).toEqual(["DECLARED_SECRET", "LATER_KEY"]);
    expect(warnSecond).not.toHaveBeenCalled();

    // Reassignment cannot drop the guardrail (property is non-writable).
    expect(() => {
      "use strict";
      (process as { env: NodeJS.ProcessEnv }).env = { DECLARED_SECRET: "leak" };
    }).toThrow();
    expect(process.env.DECLARED_SECRET).toBeUndefined();
  });

  // Regression: the @telorun/test suite runner loads its *own* @telorun/kernel
  // copy to spawn child kernels. In a deployed image that copy's module body
  // runs after the main kernel already locked process.env — a plain
  // `const REAL_ENV = process.env` there would capture the Proxy, so child
  // kernels' subprocess spawns (`npm install`) got an env missing values for the
  // denied keys. The real env is shared on globalThis, so a fresh module
  // instance recovers it. (Runs after the lock above is installed.)
  it("a kernel module instance loaded after the lock still sees the real env", async () => {
    lockControllerEnv(["CROSS_INSTANCE_PROBE"], () => {}); // ensure a denied key
    process.env.CROSS_INSTANCE_PROBE = "shared"; // write trap → real env
    vi.resetModules();
    const second = await import("../src/host-env.js");

    expect(process.env.CROSS_INSTANCE_PROBE).toBeUndefined(); // denied via Proxy
    expect(second.hostEnv().CROSS_INSTANCE_PROBE).toBe("shared"); // real, via globalThis
  });
});
