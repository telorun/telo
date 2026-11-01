import { describe, expect, it } from "vitest";

import {
  containerConfig,
  optionalContainerConfig,
  sessionConfigSchema,
  loadSessionUserFromEnv,
  loadSessionUserFromObject,
  loadTeloImageSource,
  teloImage,
  teloImageRefusal,
  validateContainerConfig,
  validateOptionalContainerConfig,
} from "./container-config.js";

describe("sessionConfigSchema", () => {
  it("advertises editable image/pullPolicy with defaults", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:0-slim" });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.default).toBe("telorun/node:0-slim");
    expect(props.image.readOnly).toBeUndefined();
    expect(props.pullPolicy.default).toBe("missing");
    expect(schema.required).toEqual(["image", "pullPolicy"]);
  });

  it("locks image (only) when enforced; pullPolicy stays editable", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:latest-slim", enforced: true });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.readOnly).toBe(true);
    expect(props.image.default).toBe("telorun/node:latest-slim");
    expect(props.pullPolicy.readOnly).toBeUndefined();
  });

  it("renders image as an editable enum picker — overriding enforced — when imageEnum is set", () => {
    const schema = sessionConfigSchema({
      imageDefault: "telorun/node:latest-slim",
      enforced: true,
      imageEnum: ["telorun/node:latest-slim", "telorun/node:0.30.1-slim"],
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.enum).toEqual(["telorun/node:latest-slim", "telorun/node:0.30.1-slim"]);
    expect(props.image.readOnly).toBeUndefined();
    expect(props.image.default).toBe("telorun/node:latest-slim");
    // pullPolicy is a client-editable freshness control.
    expect(props.pullPolicy.readOnly).toBeUndefined();
  });

  it("ignores an empty imageEnum and falls back to the enforced field", () => {
    const schema = sessionConfigSchema({
      imageDefault: "telorun/node:latest-slim",
      enforced: true,
      imageEnum: [],
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.enum).toBeUndefined();
    expect(props.image.readOnly).toBe(true);
  });
});

describe("validateContainerConfig", () => {
  it("names the missing image rather than letting the start fail later", () => {
    expect(validateContainerConfig({})).toMatch(/config\.image/);
    expect(validateContainerConfig({ image: "   " })).toMatch(/config\.image/);
  });

  it("rejects an unknown pull policy", () => {
    expect(validateContainerConfig({ image: "telorun/node:0-slim", pullPolicy: "sometimes" })).toMatch(
      /pullPolicy/,
    );
  });

  it("accepts a config with only an image, defaulting the policy", () => {
    expect(validateContainerConfig({ image: "telorun/node:0-slim" })).toBeUndefined();
    expect(containerConfig({ image: "telorun/node:0-slim" })).toEqual({
      image: "telorun/node:0-slim",
      pullPolicy: "missing",
    });
  });

  it("throws when a backend reaches it with a config no gate refused", () => {
    expect(() => containerConfig({})).toThrow(/config\.image/);
  });
});

describe("validateOptionalContainerConfig", () => {
  it("accepts an absent image — the runner supplies its own default", () => {
    expect(validateOptionalContainerConfig({})).toBeUndefined();
    expect(optionalContainerConfig({})).toEqual({ image: undefined, pullPolicy: "missing" });
  });

  it("refuses a present-but-unusable image instead of falling back to the default", () => {
    // Coercing this to `undefined` started a pod on the operator's default
    // image and told nobody.
    expect(validateOptionalContainerConfig({ image: 42 })).toMatch(/config\.image/);
    expect(validateOptionalContainerConfig({ image: "  " })).toMatch(/config\.image/);
  });

  it("refuses an unknown pull policy instead of coercing it to `missing`", () => {
    expect(validateOptionalContainerConfig({ pullPolicy: "sometimes" })).toMatch(/pullPolicy/);
    expect(() => optionalContainerConfig({ pullPolicy: "sometimes" })).toThrow(/pullPolicy/);
  });
});

describe("a session whose apps name their telo version", () => {
  it("needs no config at all", () => {
    expect(validateContainerConfig({}, { telo: true })).toBeUndefined();
  });

  it("pulls under the operator's policy, which is refused when it names none", () => {
    expect(loadTeloImageSource({}).pullPolicy).toBe("missing");
    expect(loadTeloImageSource({ RUNNER_PULL_POLICY: "never" }).pullPolicy).toBe("never");
    expect(() => loadTeloImageSource({ RUNNER_PULL_POLICY: "sometimes" })).toThrow(/RUNNER_PULL_POLICY/);
  });
});

describe("the kernel image of a telo version", () => {
  it("is the operator's repository and variant around the version", () => {
    expect(teloImage("0.80.0", loadTeloImageSource({}))).toBe("telorun/node:0.80.0-slim");
    expect(
      teloImage(
        "0.80.0",
        loadTeloImageSource({ RUNNER_TELO_IMAGE_REPOSITORY: "mirror/node", RUNNER_TELO_IMAGE_VARIANT: "full" }),
      ),
    ).toBe("mirror/node:0.80.0-full");
  });

  it("does not exist for an unreleased build, unless the operator named one for it", () => {
    const source = loadTeloImageSource({});
    expect(teloImageRefusal("0.80.0", source)).toBeUndefined();
    expect(teloImageRefusal("0.80.0+unreleased", source)).toMatch(/RUNNER_TELO_UNRELEASED_IMAGE/);

    const dev = loadTeloImageSource({ RUNNER_TELO_UNRELEASED_IMAGE: "telo-dev/node:local" });
    expect(teloImageRefusal("0.80.0+unreleased", dev)).toBeUndefined();
    expect(teloImage("0.80.0+unreleased", dev)).toBe("telo-dev/node:local");
    expect(teloImage("0.80.0", dev)).toBe("telorun/node:0.80.0-slim");
  });

  it("is advertised as the deprecated alternative once versions choose the image", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:0-slim", teloVersions: true });
    const properties = schema.properties as Record<string, { deprecated?: boolean }>;
    expect(properties.image.deprecated).toBe(true);
    expect(properties.pullPolicy.deprecated).toBe(true);
    expect(schema.required).toEqual([]);
  });
});

describe("the session user", () => {
  const FILE = { file: "/etc/telo/session.yaml", path: "user" };

  it("is 1000:1000 unless one is set, read from RUNNER_SESSION_USER or a file's map", () => {
    expect(loadSessionUserFromEnv({})).toEqual({ uid: 1000, gid: 1000 });
    expect(loadSessionUserFromObject(undefined, FILE)).toEqual({ uid: 1000, gid: 1000 });
    expect(loadSessionUserFromEnv({ RUNNER_SESSION_USER: "2000:0" })).toEqual({ uid: 2000, gid: 0 });
    expect(loadSessionUserFromObject({ uid: 2000, gid: 0 }, FILE)).toEqual({ uid: 2000, gid: 0 });
  });

  it.each([
    ["0:0", "the uid of RUNNER_SESSION_USER is 0: a session runs untrusted code, so its user is never root"],
    ["node", "RUNNER_SESSION_USER must name the user by number — write it as <uid>:<gid>, both numeric (e.g. 1000:1000), got 'node'."],
    ["1000", "RUNNER_SESSION_USER names no gid — write it as <uid>:<gid>"],
    ["1000:", "RUNNER_SESSION_USER names no gid"],
    ["1000:node", "RUNNER_SESSION_USER must name the group by number"],
  ])("refuses RUNNER_SESSION_USER=%s, naming the variable", (value, message) => {
    expect(() => loadSessionUserFromEnv({ RUNNER_SESSION_USER: value })).toThrow(message);
  });

  it.each([
    [{ uid: 0, gid: 0 }, "`user.uid` in /etc/telo/session.yaml is 0: a session runs untrusted code"],
    [{ uid: "node", gid: 1000 }, "`user.uid` in /etc/telo/session.yaml must be a number, got 'node'."],
    [{ uid: 1000 }, "`user.gid` in /etc/telo/session.yaml is required"],
    [{ uid: 1000, gid: 1000, name: "node" }, "`user.name` in /etc/telo/session.yaml is not a setting this runner reads (expected one of: uid, gid)."],
    ["1000:1000", "`user` in /etc/telo/session.yaml must be a map of a numeric uid and gid"],
  ])("refuses the file's user %j, naming the key", (value, message) => {
    expect(() => loadSessionUserFromObject(value, FILE)).toThrow(message);
  });
});
