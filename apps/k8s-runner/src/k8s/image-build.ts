import { createHash } from "node:crypto";

import type { V1Job } from "@kubernetes/client-node";
import type { RunBundle } from "@telorun/runner-core";
import { SessionStartError } from "@telorun/runner-core";

import type { ImageBuildConfig } from "../config.js";
import type { BundleStore } from "../bundle-store.js";
import type { KubeClient } from "./client.js";

const CONTEXT_DIR = "/workspace";
const POLL_INTERVAL_MS = 2_000;
/** Grace beyond the Job's own activeDeadlineSeconds before the runner gives up. */
const WAIT_GRACE_MS = 30_000;

export interface ImageTagInputs {
  bundle: RunBundle;
  /** Normalized entry path the image's `telo run` will target. */
  entryRelativePath: string;
  /** Base image the per-app image is built FROM. */
  baseImage: string;
  /** Telo module registry baked into the build (affects resolved manifests). */
  teloRegistryUrl: string;
}

/**
 * Content-address the per-app image. Two byte-identical bundles built the same
 * way map to one tag, so re-running an app reuses the image; a single change to
 * any source file, the entry, the base image, or the telo registry produces a
 * fresh tag. Files are hashed in a stable order so map iteration can't perturb
 * the digest.
 */
export function computeImageTag(inputs: ImageTagInputs): string {
  const h = createHash("sha256");
  h.update("base\0" + inputs.baseImage + "\0");
  h.update("telo-registry\0" + inputs.teloRegistryUrl + "\0");
  h.update("entry\0" + inputs.entryRelativePath + "\0");
  const files = [...inputs.bundle.files].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  for (const f of files) {
    h.update("file\0" + f.relativePath + "\0");
    h.update(f.contents);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 32);
}

export function imageRef(config: ImageBuildConfig, tag: string): string {
  return `${config.repository}:${tag}`;
}

/**
 * Dockerfile for a self-contained per-app image: `telo install` populates
 * `/app/.telo/{manifests,npm}` so the runtime `telo run /app/<entry>` resolves
 * every controller and module from disk with no network and no install. The
 * telo registry arrives as a build-arg so the build (not the running session)
 * carries the registry dependency.
 */
export function buildDockerfile(opts: { baseImage: string; entryRelativePath: string }): string {
  return [
    `FROM ${opts.baseImage}`,
    `WORKDIR /app`,
    `COPY . /app`,
    `ARG TELO_REGISTRY_URL`,
    `ENV TELO_REGISTRY_URL=$TELO_REGISTRY_URL`,
    `RUN telo install /app/${opts.entryRelativePath}`,
    ``,
  ].join("\n");
}

export interface KanikoJobArgs {
  config: ImageBuildConfig;
  jobName: string;
  /** Tokenized URL the initContainer fetches the build context (bundle + Dockerfile) from. */
  contextUrl: string;
  /** Fully-qualified image ref Kaniko pushes. */
  destination: string;
  /** Small image (wget + tar) for the context-fetch initContainer. */
  initImage: string;
  managedByLabel: string;
}

/**
 * Builds the Kaniko Job. An initContainer fetches the tokenized context tarball
 * into a shared emptyDir; Kaniko builds it and pushes to the registry. The Job
 * is single-attempt (`backoffLimit: 0`), deadline-bounded, and self-cleaning
 * (`ttlSecondsAfterFinished`). Kaniko needs a writable rootfs, so this runs in
 * the trusted `telo-builds` namespace at baseline PodSecurity — never alongside
 * untrusted session pods.
 */
export function buildKanikoJob(args: KanikoJobArgs): V1Job {
  const { config } = args;
  const kanikoArgs = [
    `--context=dir://${CONTEXT_DIR}`,
    `--dockerfile=${CONTEXT_DIR}/Dockerfile`,
    `--destination=${args.destination}`,
    `--build-arg=TELO_REGISTRY_URL=${config.teloRegistryUrl}`,
  ];
  if (config.insecureRegistry) {
    kanikoArgs.push("--insecure", "--skip-tls-verify", "--insecure-pull", "--skip-tls-verify-pull");
  }

  const labels = {
    "app.kubernetes.io/managed-by": args.managedByLabel,
    "telo.run/build": "true",
  };
  const usesPushSecret = Boolean(config.pushSecretName);

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: args.jobName, namespace: config.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: config.timeoutSeconds,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          initContainers: [
            {
              name: "context-fetch",
              image: args.initImage,
              command: ["sh", "-c"],
              args: [
                `set -e; wget -qO /tmp/context.tgz "${args.contextUrl}"; ` +
                  `tar xzf /tmp/context.tgz -C ${CONTEXT_DIR}`,
              ],
              volumeMounts: [
                { name: "context", mountPath: CONTEXT_DIR },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          containers: [
            {
              name: "kaniko",
              image: config.builderImage,
              args: kanikoArgs,
              volumeMounts: [
                { name: "context", mountPath: CONTEXT_DIR },
                ...(usesPushSecret
                  ? [{ name: "docker-config", mountPath: "/kaniko/.docker" }]
                  : []),
              ],
            },
          ],
          volumes: [
            { name: "context", emptyDir: {} },
            { name: "tmp", emptyDir: {} },
            ...(usesPushSecret
              ? [
                  {
                    name: "docker-config",
                    secret: {
                      secretName: config.pushSecretName,
                      items: [{ key: ".dockerconfigjson", path: "config.json" }],
                    },
                  },
                ]
              : []),
          ],
        },
      },
    },
  };
}

export interface EnsureImageDeps {
  kube: KubeClient;
  build: ImageBuildConfig;
  bundleStore: BundleStore;
  initImage: string;
  managedByLabel: string;
}

export interface EnsureImageArgs {
  bundle: RunBundle;
  entryRelativePath: string;
  baseImage: string;
}

/**
 * Process-local single-flight: concurrent session-creates for byte-identical
 * bundles share one build instead of each racing to create the same Job.
 */
const inFlight = new Map<string, Promise<string>>();

/**
 * Resolve the per-app image, building it on-cluster if absent. Returns the image
 * ref to run; throws `SessionStartError` (stage `create`) with the build pod's
 * log tail on failure so the cause reaches the editor instead of an opaque hang.
 */
export async function ensureSessionImage(
  deps: EnsureImageDeps,
  args: EnsureImageArgs,
): Promise<string> {
  const tag = computeImageTag({
    bundle: args.bundle,
    entryRelativePath: args.entryRelativePath,
    baseImage: args.baseImage,
    teloRegistryUrl: deps.build.teloRegistryUrl,
  });
  const ref = imageRef(deps.build, tag);

  const existing = inFlight.get(ref);
  if (existing) return existing;

  const work = buildOnce(deps, args, tag, ref).finally(() => inFlight.delete(ref));
  inFlight.set(ref, work);
  return work;
}

async function buildOnce(
  deps: EnsureImageDeps,
  args: EnsureImageArgs,
  tag: string,
  ref: string,
): Promise<string> {
  if (await imageExists(deps.kube, deps.build, tag)) return ref;

  const dockerfile = buildDockerfile({
    baseImage: args.baseImage,
    entryRelativePath: args.entryRelativePath,
  });
  const buildId = `build-${tag}`;
  const contextUrl = await deps.bundleStore.stageBuildContext(buildId, args.bundle, dockerfile);
  const jobName = `telo-build-${tag}`;
  const job = buildKanikoJob({
    config: deps.build,
    jobName,
    contextUrl,
    destination: ref,
    initImage: deps.initImage,
    managedByLabel: deps.managedByLabel,
  });

  try {
    await deps.kube.batch.createNamespacedJob({ namespace: deps.build.namespace, body: job });
  } catch (err) {
    if (!isConflict(err)) {
      deps.bundleStore.drop(buildId);
      throw new SessionStartError(
        "start_failed",
        "create",
        `failed to create image build job: ${msg(err)}`,
        msg(err),
      );
    }
    // 409: a build for this exact tag is already running (peer/prior attempt) —
    // fall through and wait for it rather than starting a duplicate.
  }

  try {
    await waitForJob(deps.kube, deps.build, jobName);
  } finally {
    deps.bundleStore.drop(buildId);
  }
  return ref;
}

async function waitForJob(
  kube: KubeClient,
  build: ImageBuildConfig,
  jobName: string,
): Promise<void> {
  const deadline = Date.now() + build.timeoutSeconds * 1000 + WAIT_GRACE_MS;
  while (Date.now() < deadline) {
    let status: V1Job["status"];
    try {
      const job = await kube.batch.readNamespacedJob({ name: jobName, namespace: build.namespace });
      status = job.status;
    } catch (err) {
      if (is404(err)) {
        throw new SessionStartError(
          "start_failed",
          "create",
          `image build job '${jobName}' disappeared before completing`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if ((status?.succeeded ?? 0) >= 1) return;
    if ((status?.failed ?? 0) >= 1) {
      const logs = await buildLogTail(kube, build.namespace, jobName);
      throw new SessionStartError(
        "start_failed",
        "create",
        `image build failed${logs ? `: ${logs}` : ""}`,
        logs || undefined,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new SessionStartError(
    "start_failed",
    "create",
    `image build did not finish within ${build.timeoutSeconds}s`,
  );
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

/** Registry pull credentials decoded from a `.dockerconfigjson` Secret. */
export interface RegistryAuth {
  username: string;
  password: string;
}

/**
 * Best-effort registry manifest HEAD; a hit lets the runner skip the build.
 * Reuses the push Secret's dockerconfig so the check authenticates against a
 * private registry — without credentials a private registry answers 401 and the
 * runner would rebuild every time. Fails safe to `false` (build) on any error.
 */
async function imageExists(
  kube: KubeClient,
  build: ImageBuildConfig,
  tag: string,
): Promise<boolean> {
  if (!build.registryApiUrl) return false;
  const repoPath = repoPathOf(build.repository);
  if (!repoPath) return false;
  try {
    const base = build.registryApiUrl.replace(/\/+$/, "");
    const url = `${base}/v2/${repoPath}/manifests/${tag}`;
    const auth = await resolveRegistryAuth(kube, build);
    const res = await manifestHead(url, repoPath, auth);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * HEAD the manifest, handling both auth schemes a registry may demand: Basic
 * (sent upfront when credentials exist) and Bearer token (acquired from the
 * realm advertised in a 401 `WWW-Authenticate` challenge, then retried).
 */
async function manifestHead(
  url: string,
  repoPath: string,
  auth: RegistryAuth | undefined,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  if (auth) headers.Authorization = `Basic ${basicCredential(auth)}`;
  const res = await fetch(url, { method: "HEAD", headers });
  if (res.status !== 401 || !auth) return res;

  const token = await acquireBearerToken(res.headers.get("www-authenticate"), repoPath, auth);
  if (!token) return res;
  return fetch(url, {
    method: "HEAD",
    headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
  });
}

/** Exchange Basic credentials for a pull token at the challenge's `realm`. */
async function acquireBearerToken(
  challenge: string | null,
  repoPath: string,
  auth: RegistryAuth,
): Promise<string | undefined> {
  if (!challenge) return undefined;
  const m = /^Bearer\s+(.*)$/i.exec(challenge.trim());
  if (!m) return undefined;
  const params = parseAuthParams(m[1]);
  if (!params.realm) return undefined;

  const tokenUrl = new URL(params.realm);
  if (params.service) tokenUrl.searchParams.set("service", params.service);
  tokenUrl.searchParams.set("scope", params.scope || `repository:${repoPath}:pull`);
  const res = await fetch(tokenUrl.toString(), {
    headers: { Authorization: `Basic ${basicCredential(auth)}` },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token;
}

/** Read + decode the push Secret's dockerconfig into credentials for the repo's host. */
async function resolveRegistryAuth(
  kube: KubeClient,
  build: ImageBuildConfig,
): Promise<RegistryAuth | undefined> {
  if (!build.pushSecretName) return undefined;
  try {
    const secret = await kube.core.readNamespacedSecret({
      name: build.pushSecretName,
      namespace: build.namespace,
    });
    const raw = secret.data?.[".dockerconfigjson"];
    if (!raw) return undefined;
    const json = Buffer.from(raw, "base64").toString("utf8");
    return parseDockerConfigAuth(json, build.repository);
  } catch {
    return undefined;
  }
}

/** Extract credentials for `repository`'s host from a `.dockerconfigjson` payload. */
export function parseDockerConfigAuth(
  dockerconfigjson: string,
  repository: string,
): RegistryAuth | undefined {
  let cfg: { auths?: Record<string, { auth?: string; username?: string; password?: string }> };
  try {
    cfg = JSON.parse(dockerconfigjson);
  } catch {
    return undefined;
  }
  const auths = cfg.auths ?? {};
  const host = registryHost(repository);
  const entry = auths[host] ?? Object.entries(auths).find(([k]) => registryHost(k) === host)?.[1];
  if (!entry) return undefined;
  if (entry.username && entry.password) {
    return { username: entry.username, password: entry.password };
  }
  if (entry.auth) {
    const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep >= 0) return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  }
  return undefined;
}

/** Host portion of a registry ref / dockerconfig key (scheme + path stripped). */
export function registryHost(ref: string): string {
  return ref.replace(/^https?:\/\//, "").split("/")[0];
}

/** Parse `key="value"` pairs out of a `WWW-Authenticate: Bearer ...` challenge. */
export function parseAuthParams(challenge: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(challenge)) !== null) params[m[1]] = m[2];
  return params;
}

function basicCredential(auth: RegistryAuth): string {
  return Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
}

/** Last log lines of the build pod, for an actionable failure message. */
async function buildLogTail(kube: KubeClient, namespace: string, jobName: string): Promise<string> {
  try {
    const pods = await kube.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) return "";
    const log = await kube.core.readNamespacedPodLog({ name: podName, namespace, tailLines: 20 });
    return typeof log === "string" ? log.trim() : "";
  } catch {
    return "";
  }
}

function repoPathOf(repository: string): string | null {
  const slash = repository.indexOf("/");
  return slash >= 0 ? repository.slice(slash + 1) : null;
}

function statusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return e?.statusCode ?? e?.code ?? e?.response?.statusCode;
}

function is404(err: unknown): boolean {
  return statusCode(err) === 404;
}

function isConflict(err: unknown): boolean {
  return statusCode(err) === 409;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
