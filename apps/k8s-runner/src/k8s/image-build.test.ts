import type { RunBundle } from "@telorun/runner-core";
import { describe, expect, it } from "vitest";

import type { ImageBuildConfig } from "../config.js";
import {
  buildDockerfile,
  buildKanikoJob,
  computeImageTag,
  imageRef,
  parseAuthParams,
  parseDockerConfigAuth,
  registryHost,
} from "./image-build.js";

const APP_DOC = [
  "kind: Telo.Application",
  "metadata:",
  "  name: app",
  "imports:",
  "  Console: std/console@0.9.0",
  "---",
  "kind: Telo.Definition",
  "metadata:",
  "  name: Thing",
  "controllers:",
  "  - pkg:npm/@acme/thing@1.0.0",
  "",
].join("\n");

const BUNDLE: RunBundle = {
  entryRelativePath: "manifest.yaml",
  files: [
    { relativePath: "manifest.yaml", contents: APP_DOC },
    { relativePath: "lib/util.yaml", contents: "kind: Telo.Library\nmetadata:\n  name: util\n" },
  ],
};

const BASE = "telorun/node:latest-slim";
const TELO_REGISTRY = "https://registry.telo.run";

function tagInputs(over: Partial<Parameters<typeof computeImageTag>[0]> = {}) {
  return {
    bundle: BUNDLE,
    baseImage: BASE,
    teloRegistryUrl: TELO_REGISTRY,
    ...over,
  };
}

function editApp(replace: string, withText: string): RunBundle {
  return {
    ...BUNDLE,
    files: [
      { relativePath: "manifest.yaml", contents: APP_DOC.replace(replace, withText) },
      BUNDLE.files[1],
    ],
  };
}

describe("computeImageTag — dependency-closure addressing", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeImageTag(tagInputs())).toBe(computeImageTag(tagInputs()));
  });

  it("is independent of file ordering in the bundle", () => {
    const reversed: RunBundle = { ...BUNDLE, files: [...BUNDLE.files].reverse() };
    expect(computeImageTag(tagInputs({ bundle: reversed }))).toBe(computeImageTag(tagInputs()));
  });

  it("ignores body-only edits that don't touch imports or controllers", () => {
    const edited = editApp("  name: app", "  name: app # renamed");
    expect(computeImageTag(tagInputs({ bundle: edited }))).toBe(computeImageTag(tagInputs()));
  });

  it("changes when an import changes", () => {
    const edited = editApp("std/console@0.9.0", "std/console@0.10.0");
    expect(computeImageTag(tagInputs({ bundle: edited }))).not.toBe(computeImageTag(tagInputs()));
  });

  it("changes when a body-declared controller changes", () => {
    const edited = editApp("pkg:npm/@acme/thing@1.0.0", "pkg:npm/@acme/thing@2.0.0");
    expect(computeImageTag(tagInputs({ bundle: edited }))).not.toBe(computeImageTag(tagInputs()));
  });

  it("changes when the base image or telo registry change", () => {
    const base = computeImageTag(tagInputs());
    expect(computeImageTag(tagInputs({ baseImage: "telorun/node:next" }))).not.toBe(base);
    expect(computeImageTag(tagInputs({ teloRegistryUrl: "https://other.example" }))).not.toBe(base);
  });

  it("produces a 32-char lowercase hex tag", () => {
    expect(computeImageTag(tagInputs())).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes with the base digest so a moved moving-tag rebuilds", () => {
    const noDigest = computeImageTag(tagInputs());
    const pinned = computeImageTag(tagInputs({ baseDigest: "sha256:aaa" }));
    const moved = computeImageTag(tagInputs({ baseDigest: "sha256:bbb" }));
    expect(pinned).not.toBe(noDigest);
    expect(moved).not.toBe(pinned);
  });
});

describe("imageRef", () => {
  it("joins repository and tag", () => {
    const cfg = { repository: "reg.example/telo-sessions" } as ImageBuildConfig;
    expect(imageRef(cfg, "abc123")).toBe("reg.example/telo-sessions:abc123");
  });
});

describe("buildDockerfile", () => {
  it("bakes the app and runs telo install at build time", () => {
    const df = buildDockerfile({ baseImage: BASE, entryRelativePath: "app/manifest.yaml" });
    expect(df).toContain(`FROM ${BASE}`);
    expect(df).toContain("COPY . /app");
    expect(df).toContain("ARG TELO_REGISTRY_URL");
    expect(df).toContain("ENV TELO_CACHE_DIR=/telo-cache");
    expect(df).toContain("RUN telo install /app/app/manifest.yaml");
  });
});

const BUILD_CONFIG: ImageBuildConfig = {
  repository: "reg.example/telo-sessions",
  namespace: "telo-builds",
  builderImage: "gcr.io/kaniko-project/executor:latest",
  timeoutSeconds: 600,
  insecureRegistry: false,
  teloRegistryUrl: TELO_REGISTRY,
};

function kanikoArgsOf(job: ReturnType<typeof buildKanikoJob>): string[] {
  return job.spec?.template?.spec?.containers?.[0]?.args ?? [];
}

describe("buildKanikoJob", () => {
  const base = {
    jobName: "telo-build-abc",
    contextUrl: "http://runner.telo-runner:8062/internal/bundles/build-abc?token=xyz",
    destination: "reg.example/telo-sessions:abc",
    initImage: "busybox:stable",
    managedByLabel: "telo-k8s-runner",
  };

  it("is a single-attempt, deadline-bounded, self-cleaning Job", () => {
    const job = buildKanikoJob({ config: BUILD_CONFIG, ...base });
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.activeDeadlineSeconds).toBe(600);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(300);
    expect(job.spec?.template?.spec?.restartPolicy).toBe("Never");
    expect(job.spec?.template?.spec?.automountServiceAccountToken).toBe(false);
    expect(job.metadata?.namespace).toBe("telo-builds");
  });

  it("fetches the tokenized context in an initContainer", () => {
    const job = buildKanikoJob({ config: BUILD_CONFIG, ...base });
    const init = job.spec?.template?.spec?.initContainers?.[0];
    expect(init?.image).toBe("busybox:stable");
    expect(init?.args?.[0]).toContain(base.contextUrl);
  });

  it("passes context, dockerfile, destination and the telo registry build-arg", () => {
    const args = kanikoArgsOf(buildKanikoJob({ config: BUILD_CONFIG, ...base }));
    expect(args).toContain("--context=dir:///workspace");
    expect(args).toContain("--dockerfile=/workspace/Dockerfile");
    expect(args).toContain(`--destination=${base.destination}`);
    expect(args).toContain(`--build-arg=TELO_REGISTRY_URL=${TELO_REGISTRY}`);
  });

  it("omits insecure flags by default and includes them when configured", () => {
    expect(kanikoArgsOf(buildKanikoJob({ config: BUILD_CONFIG, ...base }))).not.toContain("--insecure");
    const insecure = kanikoArgsOf(
      buildKanikoJob({ config: { ...BUILD_CONFIG, insecureRegistry: true }, ...base }),
    );
    expect(insecure).toContain("--insecure");
    expect(insecure).toContain("--skip-tls-verify");
  });

  it("mounts a docker-config secret only when a push secret is set", () => {
    const without = buildKanikoJob({ config: BUILD_CONFIG, ...base });
    expect(without.spec?.template?.spec?.volumes?.some((v) => v.name === "docker-config")).toBe(false);

    const withSecret = buildKanikoJob({
      config: { ...BUILD_CONFIG, pushSecretName: "reg-creds" },
      ...base,
    });
    const vol = withSecret.spec?.template?.spec?.volumes?.find((v) => v.name === "docker-config");
    expect(vol?.secret?.secretName).toBe("reg-creds");
    expect(
      withSecret.spec?.template?.spec?.containers?.[0]?.volumeMounts?.some(
        (m) => m.name === "docker-config",
      ),
    ).toBe(true);
  });
});

describe("registryHost", () => {
  it("strips scheme and path to the bare host", () => {
    expect(registryHost("registry.example.com/telo-sessions")).toBe("registry.example.com");
    expect(registryHost("https://registry.example.com/v2/")).toBe("registry.example.com");
    expect(registryHost("registry.example.com:5000/team/app")).toBe("registry.example.com:5000");
  });
});

describe("parseAuthParams", () => {
  it("parses realm, service and scope from a Bearer challenge", () => {
    const params = parseAuthParams(
      'realm="https://auth.example.com/token",service="reg.example.com",scope="repository:team/app:pull"',
    );
    expect(params.realm).toBe("https://auth.example.com/token");
    expect(params.service).toBe("reg.example.com");
    expect(params.scope).toBe("repository:team/app:pull");
  });
});

describe("parseDockerConfigAuth", () => {
  const REPO = "registry.example.com/telo-sessions";

  it("returns explicit username/password for the repo's host", () => {
    const json = JSON.stringify({
      auths: { "registry.example.com": { username: "alice", password: "s3cret" } },
    });
    expect(parseDockerConfigAuth(json, REPO)).toEqual({ username: "alice", password: "s3cret" });
  });

  it("decodes the base64 `auth` field when username/password are absent", () => {
    const auth = Buffer.from("bob:hunter2").toString("base64");
    const json = JSON.stringify({ auths: { "registry.example.com": { auth } } });
    expect(parseDockerConfigAuth(json, REPO)).toEqual({ username: "bob", password: "hunter2" });
  });

  it("matches a host even when the dockerconfig key carries a scheme", () => {
    const json = JSON.stringify({
      auths: { "https://registry.example.com/v2/": { username: "carol", password: "pw" } },
    });
    expect(parseDockerConfigAuth(json, REPO)).toEqual({ username: "carol", password: "pw" });
  });

  it("returns undefined when no entry matches the host or the json is invalid", () => {
    expect(
      parseDockerConfigAuth(JSON.stringify({ auths: { "other.io": { auth: "x" } } }), REPO),
    ).toBeUndefined();
    expect(parseDockerConfigAuth("not json", REPO)).toBeUndefined();
  });
});
