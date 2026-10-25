import type { BackendAppSpec, RunnerBackend } from "../backend.js";
import type { ResolvedRunnerApp } from "../config.js";
import {
  TELO_VERSION_PATTERN,
  unsupervisableTelo,
  type SessionAppSpec,
  type SessionConfig,
} from "../contract.js";
import { BundlePathError, normalizeBundlePath } from "./bundle-path.js";
import { SessionRefusal } from "./session-refusal.js";

/** A DNS label — the app name appears in a container name and in every run
 *  event, so it has to survive both. */
const APP_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Names a session's own containers already use, reserved in core so one rule
 *  covers every backend rather than one being safe only by its own prefix. */
const RESERVED_APP_NAMES = new Set(["workspace", "agent"]);

/**
 * Normalize an app set, refusing it with the reason when it cannot be run.
 *
 * Ports are unique across the WHOLE session, not per app: session hosts are
 * `<port>-<sessionId>.<base-domain>`, a single label, so two apps both listening
 * on 3000 collide with nothing to distinguish them.
 */
export function resolveApps(declared: SessionAppSpec[], teloVersions: boolean): BackendAppSpec[] {
  const seenNames = new Set<string>();
  const portOwner = new Map<string, string>();
  const apps: BackendAppSpec[] = [];

  for (const spec of declared) {
    if (!APP_NAME_PATTERN.test(spec.name)) {
      throw new SessionRefusal(
        400,
        "invalid_app_name",
        `app name '${spec.name}' must be a DNS label (lowercase alphanumeric and '-')`,
      );
    }
    if (RESERVED_APP_NAMES.has(spec.name)) {
      throw new SessionRefusal(
        400,
        "reserved_app_name",
        `app name '${spec.name}' is reserved — a session's own containers use it`,
      );
    }
    if (seenNames.has(spec.name)) {
      throw new SessionRefusal(400, "duplicate_app_name", `app '${spec.name}' is declared twice`);
    }
    seenNames.add(spec.name);

    let entryRelativePath: string;
    try {
      entryRelativePath = normalizeBundlePath(spec.entryRelativePath);
    } catch (err) {
      if (err instanceof BundlePathError) {
        throw new SessionRefusal(400, "invalid_entry", err.message);
      }
      throw err;
    }

    const ports = spec.ports ?? [];
    for (const port of ports) {
      const key = `${port.protocol}/${port.port}`;
      const owner = portOwner.get(key);
      if (owner) {
        throw new SessionRefusal(
          400,
          "port_conflict",
          `apps '${owner}' and '${spec.name}' both declare ${port.protocol} port ${port.port}; ` +
            `session hosts carry no app name, so the two would be indistinguishable`,
        );
      }
      portOwner.set(key, spec.name);
    }

    if (spec.telo !== undefined) {
      if (!teloVersions) {
        throw new SessionRefusal(
          400,
          "telo_version_unsupported",
          `app '${spec.name}' names telo ${spec.telo}, and this runner does not choose a telo ` +
            `version per application (see /v1/capabilities)`,
        );
      }
      if (!TELO_VERSION_PATTERN.test(spec.telo)) {
        throw new SessionRefusal(
          400,
          "invalid_telo_version",
          `app '${spec.name}' names telo '${spec.telo}', which is not a release version`,
        );
      }
    }

    apps.push({
      name: spec.name,
      entryRelativePath,
      ports: ports.map((p) => ({ port: p.port, protocol: p.protocol })),
      ...(spec.telo !== undefined ? { telo: spec.telo } : {}),
    });
  }

  // One answer per session to "who chooses what runs": every application names
  // its telo version, or none does and the runner's own config chooses.
  const naming = apps.filter((a) => a.telo !== undefined).length;
  if (naming !== 0 && naming !== apps.length) {
    throw new SessionRefusal(
      400,
      "invalid_telo_version",
      "either every app of a session names its `telo` version, or none does",
    );
  }
  return apps;
}

/**
 * Have the backend make every telo version the apps name runnable — judged
 * when an app set is created or replaced, because that is when an app's image
 * is chosen. Refuses with `400 telo_version_unavailable` on the first one it
 * cannot supply.
 */
export async function supplyTeloVersions(
  backend: RunnerBackend,
  apps: BackendAppSpec[],
  config: SessionConfig,
): Promise<void> {
  // Present on every backend whose runner advertises the feature — `buildServer`
  // refuses the pairing otherwise — and a version only reaches here when it does.
  const supply = backend.supplyTelo?.bind(backend);
  if (!supply) return;
  const asked = new Map<string, string>();
  for (const app of apps) {
    if (app.telo !== undefined && !asked.has(app.telo)) asked.set(app.telo, app.name);
  }
  for (const [version, app] of asked) {
    // The floor is core's: what a runner asks of a telo — its flags, its debug
    // stream — is the contract's, the same on every backend.
    const reason = unsupervisableTelo(version) ?? (await supply(version, config));
    if (reason !== undefined) {
      throw new SessionRefusal(
        400,
        "telo_version_unavailable",
        `telo ${version} cannot be run for app '${app}': ${reason}`,
        { app, version, reason },
      );
    }
  }
}

/** Refuse an app set larger than the backend's workload has slots for. */
export function refuseTooManyApps(backend: RunnerBackend, apps: BackendAppSpec[]): void {
  if (backend.maxApps === undefined || apps.length <= backend.maxApps) return;
  throw new SessionRefusal(
    400,
    "too_many_apps",
    `a session runs at most ${backend.maxApps} apps on this runner; this one declares ${apps.length}`,
  );
}

/** Refuse an app set declaring a port the backend's workload binds itself. */
export function refuseReservedPorts(backend: RunnerBackend, apps: BackendAppSpec[]): void {
  const reserved = backend.reservedPorts?.(apps) ?? [];
  for (const app of apps) {
    for (const port of app.ports) {
      const taken = reserved.find((r) => r.port === port.port && r.protocol === port.protocol);
      if (!taken) continue;
      throw new SessionRefusal(
        400,
        "port_conflict",
        `app '${app.name}' declares ${port.protocol} port ${port.port}, which this runner reserves ` +
          `for ${taken.purpose}${taken.app === undefined ? "" : ` of app '${taken.app}'`}`,
      );
    }
  }
}

/** The agent a session runs, and why a requested one does not run. */
export interface AdmittedAgent {
  agent: ResolvedRunnerApp | undefined;
  notice?: string;
}

/**
 * Resolve a requested co-resident agent against the operator catalog.
 *
 * An app declaring the agent's port is a clash. On a create the MANIFEST wins
 * (`onClash: "drop"`): the agent is dropped and the reason returned as a notice
 * for the session's stream, rather than refusing to open a workspace over a
 * container the user cannot decline. Asked for on its own (`PUT …/agent`), the
 * clash is the answer (`onClash: "refuse"`).
 */
export function admitAgent(
  name: string | null | undefined,
  catalog: Record<string, ResolvedRunnerApp>,
  apps: BackendAppSpec[],
  onClash: "drop" | "refuse",
): AdmittedAgent {
  if (name === null || name === undefined) return { agent: undefined };
  const agent = catalog[name];
  if (!agent) {
    const offered = Object.keys(catalog);
    throw new SessionRefusal(
      400,
      "unknown_agent",
      `agent '${name}' is not offered by this runner` +
        (offered.length > 0 ? ` — offered: ${offered.join(", ")}` : ""),
    );
  }
  // An agent nothing can reach would write the workspace and never be asked
  // to. The port is the operator's to declare, so the refusal names their config.
  if (agent.port === undefined) {
    throw new SessionRefusal(
      400,
      "agent_port_undeclared",
      `agent '${name}' declares no port, so this runner cannot route it — ` +
        `set RUNNER_APPS.${name}.port to the port its image listens on`,
    );
  }
  const clash = agentPortClash(agent, apps);
  if (clash && onClash === "refuse") {
    throw new SessionRefusal(
      400,
      "agent_port_conflict",
      `agent '${name}' listens on tcp port ${agent.port}, which app '${clash.name}' declares`,
    );
  }
  if (clash) {
    return {
      agent: undefined,
      notice:
        `co-resident agent '${name}' was not started: it listens on tcp port ${agent.port}, ` +
        `which app '${clash.name}' declares`,
    };
  }
  return { agent };
}

/** The app declaring the tcp port the agent listens on, if any: in one pod the
 *  two cannot both bind it. */
export function agentPortClash(
  agent: ResolvedRunnerApp,
  apps: BackendAppSpec[],
): BackendAppSpec | undefined {
  return apps.find((a) => a.ports.some((p) => p.protocol === "tcp" && p.port === agent.port));
}
