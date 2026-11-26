#!/usr/bin/env node
// `node scripts/k8s-runner-chart-e2e.mjs` — installs the k8s runner's chart into
// the current kube context in each of its configurations and checks every one
// is alive: the render is read as strictly as Flux's post-render reads it (a
// repeated mapping key fails the upgrade there while `helm install` accepts
// it), `helm install --wait` brings every Deployment up, `/v1/health` reports
// the chart's appVersion and `/v1/capabilities` advertises exactly what the
// configuration turns on.
//
//   node scripts/k8s-runner-chart-e2e.mjs install <configuration> [image options]
//       Installs one configuration and leaves it running.
//   node scripts/k8s-runner-chart-e2e.mjs all [--skip <configuration>]... [image options]
//       Installs, checks and uninstalls each configuration in turn.
//   node scripts/k8s-runner-chart-e2e.mjs render
//       Renders every configuration and reads it strictly; needs no cluster.
//   node scripts/k8s-runner-chart-e2e.mjs uninstall
//       Removes the release and both namespaces.
//
//   image options: --image-repository <repo> --image-tag <tag> --session-image <image>
//       The runner image and the kernel image, already loaded into the cluster's
//       nodes (both are run with pull policy Never).
//
// The configurations together render every conditional of the chart's
// templates on at least once and off at least once: the two session stores and
// both ways of naming a Postgres URL, every routing mode, the ingress TLS
// Secret named and rendered, shares over both routing layers, identity, terms,
// an agent by image and by module, the secret seed, namespaces created and
// pre-created, the quota and the network policy on and off, and every optional
// session setting. Shares need a Postgres store, so the database is a pod the
// script deploys; Gateway API mode needs the CRDs, applied from a pinned release.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse, parseAllDocuments } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHART = join(ROOT, "apps/k8s-runner/chart");
const RELEASE = "telo-runner";
const RUNNER_NAMESPACE = "telo-runner";
const SESSION_NAMESPACE = "telo-sessions";
const DATABASE_NAMESPACE = "telo-chart-e2e-db";
const DATABASE_URL = `postgres://postgres:e2e@db.${DATABASE_NAMESPACE}.svc.cluster.local:5432/postgres`;
const BASE_DOMAIN = "chart-e2e.test";
const IDENTITY = { audience: "https://runner.chart-e2e.test", issuers: ["https://accounts.chart-e2e.test"] };
const LOCAL_PORT = 18062;
const GATEWAY_API = {
  url: "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml",
  sha256: "4e2602c4cbe1afbc394d86f4ac6522e1a5263b01133bba1e40a6d1a549e753a1",
};

const work = mkdtempSync(join(tmpdir(), "k8s-runner-chart-e2e-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...options });
}

function kubectlApply(manifest) {
  run("kubectl", ["apply", "-f", "-"], { input: manifest, stdio: ["pipe", "inherit", "inherit"] });
}

function configurations({ imageRepository, imageTag, sessionImage }) {
  const image = { repository: imageRepository, tag: imageTag, pullPolicy: "Never" };
  return [
    {
      // The session-container test's runner: sqlite, logs-only, the defaults.
      name: "session-containers",
      values: {
        image,
        session: { image: sessionImage, baseImages: { enabled: false }, containers: { enabled: true } },
        sessionRouting: { mode: "none" },
      },
      expect: {},
    },
    {
      name: "gateway-shares",
      prepare() {
        ensureGatewayApi();
        ensureDatabase();
        createNamespaces();
        secret(RUNNER_NAMESPACE, "runner-db", { uri: DATABASE_URL });
        secret(RUNNER_NAMESPACE, "runner-seed", { seed: randomBytes(32).toString("base64url") });
        secret(RUNNER_NAMESPACE, "agent-secrets", { openai: "e2e" });
      },
      values: {
        image,
        createNamespaces: false,
        runner: {
          displayName: "Chart e2e",
          description: "Every optional setting on.",
          maxSessions: 4,
          terms: { enabled: true, title: "Terms", version: "e2e-1", body: "Development use only.\n" },
        },
        sessionStore: { kind: "postgres", existingSecret: "runner-db", existingSecretKey: "uri" },
        secretSeed: { existingSecret: "runner-seed", existingSecretKey: "seed" },
        sessionStorage: { storageClass: "standard" },
        identity: IDENTITY,
        agent: {
          image: sessionImage,
          pullPolicy: "never",
          port: 17234,
          tokenEnv: "AGENT_TOKEN",
          title: "Agent",
          description: "The co-resident agent.",
          env: { E2E: "1" },
          secretEnv: { OPENAI_API_KEY: { secretName: "agent-secrets", key: "openai" } },
        },
        session: {
          image: sessionImage,
          user: { uid: 1000, gid: 1000 },
          teloReleasesUrl: "https://releases.chart-e2e.test",
          teloImages: { pullPolicy: "never" },
          imagePullSecret: "session-pull",
          runtimeClass: "chart-e2e",
          keepFailedPods: true,
          containers: { enabled: true },
          baseImages: { enabled: true, pinnedOnly: false },
        },
        sessionRouting: {
          mode: "gateway",
          baseDomain: BASE_DOMAIN,
          dataPlaneNamespace: "gateway-system",
          gateway: { name: "gateway", namespace: "gateway-system", sectionName: "https" },
        },
        shares: { enabled: true },
        resourceQuota: { enabled: false },
      },
      expect: { shares: true, identity: true, agents: true, terms: "e2e-1", displayName: "Chart e2e" },
    },
    {
      name: "ingress-shares",
      prepare() {
        ensureDatabase();
      },
      get values() {
        const certificate = selfSignedCertificate();
        return {
        image,
        sessionStore: { kind: "postgres", url: DATABASE_URL },
        identity: IDENTITY,
        agent: {
          moduleRef: "oci://ghcr.io/telorun/authoring-agent@0.41.0",
          port: 17234,
          resources: { limits: { cpu: "1" } },
        },
        session: {
          image: sessionImage,
          baseImages: { enabled: false },
          resources: { limits: { cpu: "1" } },
        },
        sessionRouting: {
          mode: "ingress",
          baseDomain: BASE_DOMAIN,
          ingress: { className: "nginx", tls: { cert: certificate.cert, key: certificate.key } },
        },
        shares: { enabled: true },
        resourceQuota: { hard: { "limits.cpu": "16" } },
        networkPolicy: { enabled: false },
        };
      },
      expect: { shares: true, identity: true, agents: true },
    },
    {
      name: "auto-ingress-sqlite",
      prepare() {
        createNamespaces();
        const certificate = selfSignedCertificate();
        run("kubectl", ["-n", SESSION_NAMESPACE, "create", "secret", "tls", "session-tls",
          "--cert", certificate.certFile, "--key", certificate.keyFile], { stdio: ["pipe", "inherit", "inherit"] });
      },
      values: {
        image,
        createNamespaces: false,
        sessionStore: { kind: "sqlite", persistence: { storageClass: "standard" } },
        session: { image: sessionImage, baseImages: { enabled: false } },
        sessionRouting: {
          mode: "auto",
          baseDomain: BASE_DOMAIN,
          dataPlaneNamespace: "ingress-nginx",
          ingress: { className: "nginx", tls: { secretName: "session-tls" } },
        },
      },
      expect: {},
    },
  ];
}

let certificate;
function selfSignedCertificate() {
  if (certificate) return certificate;
  const keyFile = join(work, "tls.key");
  const certFile = join(work, "tls.crt");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=*.${BASE_DOMAIN}`, "-keyout", keyFile, "-out", certFile], { stdio: ["pipe", "pipe", "pipe"] });
  certificate = { keyFile, certFile, key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  return certificate;
}

let gatewayApiApplied = false;
function ensureGatewayApi() {
  if (gatewayApiApplied) return;
  const file = join(work, "gateway-api.yaml");
  run("curl", ["-fsSL", "-o", file, GATEWAY_API.url]);
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (digest !== GATEWAY_API.sha256) {
    throw new Error(`${GATEWAY_API.url} has sha256 ${digest}, not the pinned ${GATEWAY_API.sha256}`);
  }
  run("kubectl", ["apply", "--server-side", "-f", file], { stdio: ["pipe", "inherit", "inherit"] });
  run("kubectl", ["wait", "--for", "condition=established", "--timeout=60s",
    "crd/gateways.gateway.networking.k8s.io", "crd/httproutes.gateway.networking.k8s.io"],
  { stdio: ["pipe", "inherit", "inherit"] });
  gatewayApiApplied = true;
}

let databaseDeployed = false;
function ensureDatabase() {
  if (databaseDeployed) return;
  kubectlApply(`
apiVersion: v1
kind: Namespace
metadata: { name: ${DATABASE_NAMESPACE} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: db, namespace: ${DATABASE_NAMESPACE} }
spec:
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      containers:
        - name: postgres
          image: pgvector/pgvector:pg18
          imagePullPolicy: IfNotPresent
          env: [{ name: POSTGRES_PASSWORD, value: e2e }]
          ports: [{ containerPort: 5432 }]
          readinessProbe:
            exec: { command: [pg_isready, -U, postgres] }
            periodSeconds: 2
---
apiVersion: v1
kind: Service
metadata: { name: db, namespace: ${DATABASE_NAMESPACE} }
spec:
  selector: { app: db }
  ports: [{ port: 5432 }]
`);
  run("kubectl", ["-n", DATABASE_NAMESPACE, "rollout", "status", "deploy/db", "--timeout=180s"],
    { stdio: ["pipe", "inherit", "inherit"] });
  databaseDeployed = true;
}

/** The namespaces as the chart would create them, for a configuration that
 *  pre-creates them (`createNamespaces: false`). */
function createNamespaces() {
  kubectlApply(`
apiVersion: v1
kind: Namespace
metadata: { name: ${RUNNER_NAMESPACE} }
---
apiVersion: v1
kind: Namespace
metadata:
  name: ${SESSION_NAMESPACE}
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
`);
}

function secret(namespace, name, data) {
  const literals = Object.entries(data).map(([key, value]) => `--from-literal=${key}=${value}`);
  run("kubectl", ["-n", namespace, "create", "secret", "generic", name, ...literals],
    { stdio: ["pipe", "inherit", "inherit"] });
}

/** Flux post-renders every chart and its YAML reader refuses a repeated mapping
 *  key, so the render is read here as strictly. */
function renderStrictly(configuration, valuesFile) {
  const rendered = run("helm", ["template", RELEASE, CHART, "-f", valuesFile]);
  const errors = parseAllDocuments(rendered).flatMap((document) => document.errors);
  if (errors.length > 0) {
    throw new Error(
      `${configuration.name}: the chart renders YAML Flux's post-render refuses:\n` +
        errors.map((error) => `  ${error.code}: ${error.message}`).join("\n"),
    );
  }
}

async function install(configuration) {
  console.log(`\n=== ${configuration.name}`);
  const valuesFile = join(work, `${configuration.name}.json`);
  writeFileSync(valuesFile, JSON.stringify(configuration.values, null, 2));
  renderStrictly(configuration, valuesFile);
  configuration.prepare?.();
  try {
    run("helm", ["install", RELEASE, CHART, "-f", valuesFile, "--wait", "--timeout", "5m"],
      { stdio: ["pipe", "inherit", "inherit"] });
    await checkAlive(configuration);
  } catch (error) {
    showCluster();
    throw error;
  }
  console.log(`${configuration.name}: alive`);
}

async function checkAlive(configuration) {
  const forward = spawn("kubectl", ["-n", RUNNER_NAMESPACE, "port-forward", "svc/telo-k8s-runner", `${LOCAL_PORT}:8062`],
    { stdio: ["ignore", "pipe", "pipe"] });
  let forwardOutput = "";
  forward.stdout.on("data", (chunk) => (forwardOutput += chunk));
  forward.stderr.on("data", (chunk) => (forwardOutput += chunk));
  try {
    const health = await getJson("/v1/health", forward, () => forwardOutput);
    const { appVersion } = parse(readFileSync(join(CHART, "Chart.yaml"), "utf8"));
    if (health.ok !== true || health.version !== String(appVersion)) {
      throw new Error(`${configuration.name}: /v1/health answered ${JSON.stringify(health)}, expected ok at ${appVersion}`);
    }
    const capabilities = await getJson("/v1/capabilities", forward, () => forwardOutput);
    const problems = capabilityProblems(capabilities, configuration.expect);
    if (problems.length > 0) {
      throw new Error(`${configuration.name}: /v1/capabilities disagrees with its configuration:\n  ${problems.join("\n  ")}`);
    }
  } finally {
    forward.kill();
  }
}

function capabilityProblems(capabilities, expect) {
  const advertised = {
    shares: capabilities.features?.shares !== undefined,
    identity: capabilities.identity !== undefined,
    agents: Array.isArray(capabilities.features?.agents),
    terms: capabilities.terms !== undefined,
  };
  const problems = Object.entries(advertised)
    .filter(([feature, present]) => present !== Boolean(expect[feature]))
    .map(([feature, present]) => (present ? `${feature} is advertised but not configured` : `${feature} is configured but not advertised`));
  if (typeof expect.terms === "string" && capabilities.terms?.version !== expect.terms) {
    problems.push(`terms.version is ${JSON.stringify(capabilities.terms?.version)}, expected ${JSON.stringify(expect.terms)}`);
  }
  if (expect.displayName !== undefined && capabilities.displayName !== expect.displayName) {
    problems.push(`displayName is ${JSON.stringify(capabilities.displayName)}, expected ${JSON.stringify(expect.displayName)}`);
  }
  return problems;
}

async function getJson(path, forward, forwardOutput) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (forward.exitCode !== null) throw new Error(`the port-forward ended (${forward.exitCode}): ${forwardOutput()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}${path}`);
      if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${path} could not be read through the port-forward: ${lastError?.message}\n${forwardOutput()}`);
}

function uninstall() {
  const status = spawnSync("helm", ["status", RELEASE], { stdio: "ignore" });
  if (status.status === 0) {
    run("helm", ["uninstall", RELEASE, "--wait", "--timeout", "3m"], { stdio: ["pipe", "inherit", "inherit"] });
  }
  run("kubectl", ["delete", "namespace", RUNNER_NAMESPACE, SESSION_NAMESPACE, "--ignore-not-found", "--wait", "--timeout=180s"],
    { stdio: ["pipe", "inherit", "inherit"] });
}

/** Diagnostics for a failed configuration; each command's own failure is
 *  printed with its exit status, and the configuration's error is rethrown. */
function showCluster() {
  const commands = [
    ["helm", ["status", RELEASE]],
    ["kubectl", ["get", "pods,deployments,services,pvc", "-A", "-o", "wide"]],
    ["kubectl", ["-n", RUNNER_NAMESPACE, "describe", "pods"]],
    ["kubectl", ["-n", RUNNER_NAMESPACE, "logs", "deploy/telo-k8s-runner", "--tail", "200"]],
    ["kubectl", ["-n", RUNNER_NAMESPACE, "logs", "deploy/telo-k8s-runner-relay", "--tail", "200"]],
  ];
  for (const [command, args] of commands) {
    console.log(`\n$ ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, { encoding: "utf8" });
    process.stdout.write(result.stdout ?? "");
    process.stdout.write(result.stderr ?? "");
    if (result.status !== 0) console.log(`(exit ${result.status ?? result.error?.message})`);
  }
}

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    "image-repository": { type: "string", default: "telo-k8s-runner" },
    "image-tag": { type: "string", default: "e2e" },
    "session-image": { type: "string", default: "telo-dev/node:local" },
    skip: { type: "string", multiple: true, default: [] },
  },
});
const [command, name] = positionals;
const all = configurations({
  imageRepository: options["image-repository"],
  imageTag: options["image-tag"],
  sessionImage: options["session-image"],
});

if (command === "install") {
  const configuration = all.find((candidate) => candidate.name === name);
  if (!configuration) throw new Error(`no configuration '${name}'; there are ${all.map((c) => c.name).join(", ")}`);
  await install(configuration);
} else if (command === "all") {
  const unknown = options.skip.filter((skipped) => !all.some((candidate) => candidate.name === skipped));
  if (unknown.length > 0) throw new Error(`--skip names no configuration: ${unknown.join(", ")}`);
  for (const configuration of all.filter((candidate) => !options.skip.includes(candidate.name))) {
    await install(configuration);
    uninstall();
  }
} else if (command === "render") {
  for (const configuration of all) {
    const valuesFile = join(work, `${configuration.name}.json`);
    writeFileSync(valuesFile, JSON.stringify(configuration.values, null, 2));
    renderStrictly(configuration, valuesFile);
    console.log(`${configuration.name}: renders strictly`);
  }
} else if (command === "uninstall") {
  uninstall();
} else {
  throw new Error(
    "usage: k8s-runner-chart-e2e.mjs install <configuration> | all [--skip <configuration>]... | render | uninstall",
  );
}
