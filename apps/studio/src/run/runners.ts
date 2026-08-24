import {
  LOCAL_DOCKER_RUNNER_ID,
  TELO_CLOUD_RUNNER_ID,
  type AppSettings,
  type RunnerInstance,
} from "../model";
import { DEFAULT_RUNNER_URL } from "./adapters/http-runner/config-schema";
import {
  localDockerDefaultConfig,
  type LocalDockerConfig,
} from "./adapters/local-docker/config-schema";

const LOCAL_DOCKER_ADAPTER_ID = "local-docker";
/** The removed Rust-side adapter this one supersedes; persisted instances and
 *  legacy keyed configs still reference it and are migrated in place. */
const LEGACY_TAURI_ADAPTER_ID = "tauri-docker";
/** tauri-docker's seeded default image — superseded by docker-runner's default
 *  session image; anything else is a deliberate user choice and carries over. */
const LEGACY_TAURI_DEFAULT_IMAGE = "telorun/telo:nodejs";

/** The seeded Telo Cloud runner — an http-runner pointed at the hosted runner. */
function cloudRunner(): RunnerInstance {
  return {
    id: TELO_CLOUD_RUNNER_ID,
    name: "Telo Cloud",
    adapterId: "http-runner",
    config: { baseUrl: DEFAULT_RUNNER_URL },
  };
}

/** The seeded local Docker runner — the editor-managed docker-runner singleton.
 *  Present only under Tauri (its supervisor lives in the Rust shell). */
function localDockerRunner(config?: unknown): RunnerInstance {
  return {
    id: LOCAL_DOCKER_RUNNER_ID,
    name: "Local (docker)",
    adapterId: LOCAL_DOCKER_ADAPTER_ID,
    config: config ?? { ...localDockerDefaultConfig },
    builtIn: true,
  };
}

/** Map a persisted tauri-docker config onto the local-docker session config:
 *  `image`/`pullPolicy` carry over (except the obsolete default image), the
 *  remote-daemon `dockerHost` option is dropped — the supervisor targets the
 *  default local daemon only. */
function mapLegacyTauriConfig(config: unknown): LocalDockerConfig {
  if (!config || typeof config !== "object") return { ...localDockerDefaultConfig };
  const { image, pullPolicy } = config as { image?: unknown; pullPolicy?: unknown };
  return {
    image:
      typeof image === "string" && image.trim() !== "" && image !== LEGACY_TAURI_DEFAULT_IMAGE
        ? image
        : localDockerDefaultConfig.image,
    pullPolicy:
      pullPolicy === "always" || pullPolicy === "never"
        ? pullPolicy
        : localDockerDefaultConfig.pullPolicy,
  };
}

interface LegacySettings {
  activeRunAdapterId?: string;
  runAdapterConfig?: Record<string, unknown>;
}

/** Build runner instances from the pre-unification settings shape
 *  (`runAdapterConfig` keyed by adapter id + a single `activeRunAdapterId`). */
function migrateLegacy(legacy: LegacySettings): { runners: RunnerInstance[]; activeId?: string } {
  const cfg = legacy.runAdapterConfig ?? {};
  const runners: RunnerInstance[] = [];
  let activeId: string | undefined;

  const dockerApi = cfg["docker-api"];
  if (dockerApi && typeof dockerApi === "object") {
    runners.push({ id: "migrated-docker", name: "Docker", adapterId: "http-runner", config: dockerApi });
    if (legacy.activeRunAdapterId === "docker-api") activeId = "migrated-docker";
  }
  const k8s = cfg["k8s"];
  if (k8s && typeof k8s === "object") {
    runners.push({ id: "migrated-k8s", name: "Kubernetes", adapterId: "http-runner", config: k8s });
    if (legacy.activeRunAdapterId === "k8s") activeId = "migrated-k8s";
  }
  if (legacy.activeRunAdapterId === LEGACY_TAURI_ADAPTER_ID) activeId = LOCAL_DOCKER_RUNNER_ID;

  return { runners, activeId };
}

/**
 * Reconcile persisted run settings into the runner-instance model. Migrates the
 * legacy single-config-per-adapter shape and tauri-docker instances, guarantees
 * the seeded built-ins exist (Telo Cloud always; Local docker only under
 * Tauri), and ensures `activeRunnerId` points at a real runner. Idempotent.
 */
export function normalizeRunnerSettings(settings: AppSettings, isTauriEnv: boolean): AppSettings {
  const legacy = settings as AppSettings & LegacySettings;
  let runners: RunnerInstance[] = Array.isArray(settings.runners) ? [...settings.runners] : [];
  let activeRunnerId = settings.activeRunnerId;

  // Legacy migration: no `runners` yet but the old keyed config is present.
  if (runners.length === 0 && legacy.runAdapterConfig) {
    const migrated = migrateLegacy(legacy);
    runners = migrated.runners;
    if (!activeRunnerId && migrated.activeId) activeRunnerId = migrated.activeId;
  }

  // Migrate persisted tauri-docker instances in place (same id, so
  // `activeRunnerId` keeps pointing at them).
  runners = runners.map((r) =>
    r.adapterId === LEGACY_TAURI_ADAPTER_ID
      ? { ...r, adapterId: LOCAL_DOCKER_ADAPTER_ID, config: mapLegacyTauriConfig(r.config) }
      : r,
  );

  // Ensure the Telo Cloud built-in exists.
  if (!runners.some((r) => r.id === TELO_CLOUD_RUNNER_ID)) {
    runners.unshift(cloudRunner());
  }

  // Local docker built-in: present under Tauri, absent otherwise.
  const hasLocal = runners.some((r) => r.id === LOCAL_DOCKER_RUNNER_ID);
  if (isTauriEnv && !hasLocal) {
    const legacyLocalConfig = legacy.runAdapterConfig?.[LEGACY_TAURI_ADAPTER_ID];
    runners.push(
      localDockerRunner(legacyLocalConfig ? mapLegacyTauriConfig(legacyLocalConfig) : undefined),
    );
  } else if (!isTauriEnv && hasLocal) {
    runners = runners.filter((r) => r.id !== LOCAL_DOCKER_RUNNER_ID);
  }

  // Guarantee a valid active selection.
  if (!runners.some((r) => r.id === activeRunnerId)) {
    activeRunnerId = runners[0]?.id ?? TELO_CLOUD_RUNNER_ID;
  }

  const next: AppSettings = { ...settings, runners, activeRunnerId };
  // Drop the legacy fields so they don't linger in persisted settings.
  delete (next as AppSettings & LegacySettings).activeRunAdapterId;
  delete (next as AppSettings & LegacySettings).runAdapterConfig;
  return next;
}
