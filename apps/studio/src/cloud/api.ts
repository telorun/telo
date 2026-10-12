import { CloudUnreachableError, type CloudRequest, type CloudTransport } from "./transport";

export type ProjectRole = "admin" | "deployer" | "viewer";

export interface CloudProject {
  id: string;
  name: string;
  slug: string;
  effectiveRole: ProjectRole;
}

/** Where a stage's environments run, as far as Studio names it: one of the
 *  organization's own targets, or one of its subscriptions to a hosting tier. */
export type PlacementRef =
  | { kind: "target"; targetId: string }
  | { kind: "subscription"; subscriptionId: string };

/** One place the first stage of a new project may run on. */
export interface ProjectPlacementOption {
  placement: PlacementRef;
  /** The target's name, or the tier's. */
  name: string;
  /** Who provides it when it is not the organization's own. */
  provider: { name: string; verified: boolean } | null;
  /** The organization's default: what a new project gets when it names none. */
  isDefault: boolean;
}

export interface NewProject {
  name: string;
  slug: string;
  /** Left out: Telo Cloud places the first stage itself, or creates none when
   *  the organization has nowhere to run it. */
  placement?: PlacementRef;
}

/** The organization's name on Telo Cloud's registry, claimed once and for good. */
export interface RegistryNamespace {
  name: string;
  host: string;
}

export interface CloudStage {
  id: string;
  name: string;
  slug: string;
  position: number;
  /** Deploying to it needs the project role `admin`. */
  protected: boolean;
  /** The target's name, or the tier's. */
  placementName: string;
}

export interface CloudApp {
  id: string;
  name: string;
  slug: string;
  /** The module the app runs, when it is one of this project's. */
  moduleId: string | null;
  /** The directory of that module's `telo.yaml`; "" at the repository root. */
  modulePath: string | null;
}

export type DeploymentStatus =
  | "queued"
  | "resolving"
  | "applying"
  | "progressing"
  | "healthy"
  | "failed"
  | "canceled"
  | "superseded";

export type DeploymentTrigger = "deploy" | "rollback" | "promote" | "redeploy" | "restart";

/** A deployment as an overview names it. */
export interface DeploymentSummary {
  id: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  version: string;
  digest: string | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CloudEnvironment {
  id: string;
  appId: string;
  /** Null only on an environment older than stages. */
  stageId: string | null;
  /** Its stage's name. */
  name: string;
  slug: string;
  protected: boolean;
  suspended: boolean;
  health: "unknown" | "healthy" | "degraded" | "missing";
  replicas: number;
  readyReplicas: number | null;
  currentDeploymentId: string | null;
  /** Config or secrets changed since the serving deployment was created. */
  configChangedSinceDeploy: boolean;
  placementName: string;
}

export interface EnvironmentState {
  environment: CloudEnvironment;
  /** The deployment that serves. */
  currentDeployment: DeploymentSummary | null;
  /** The newest deployment of any status. */
  latestDeployment: DeploymentSummary | null;
}

export interface AppDeploymentState {
  app: CloudApp;
  /** In the order of the project's stages. */
  environments: EnvironmentState[];
}

export interface Deployment {
  id: string;
  environmentId: string;
  status: DeploymentStatus;
  source: { ref: string; version: string; digest: string | null };
  error: { code: string; message: string; detail: string | null } | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  promotedFromId: string | null;
  rollbackOfId: string | null;
}

/** One step of a deployment, as its event stream reports it. */
export interface DeploymentEvent {
  seq: number;
  at: string;
  status: DeploymentStatus;
  message: string;
  /** The failure's code, on the event of a failure. */
  code: string | null;
  detail: string | null;
}

export interface ConfigVar {
  key: string;
  isSecret: boolean;
  /** Never sent back for a secret. */
  value: string | null;
  updatedAt: string;
}

/** What became of the deploy a publication asked for. */
export interface PublicationDeploy {
  stageId: string;
  /** `pending` until the publication is published and the deployment started;
   *  `started` is final: the deployment is then followed on its own. */
  status: "pending" | "started" | "failed" | "skipped";
  environmentId: string | null;
  deploymentId: string | null;
  error: { code: string; message?: string; details?: Record<string, unknown> | null } | null;
}

export interface RepositoryLimits {
  maxFileBytes: number;
  maxSnapshotFiles: number;
  maxSnapshotBytes: number;
  maxCommitChanges: number;
  maxCommitBytes: number;
}

export interface CloudRepository {
  id: string;
  kind: string;
  defaultBranch: string;
  status: string;
  limits: RepositoryLimits;
}

export interface BranchHead {
  branch: string;
  /** Null when the branch does not exist: an empty repository. */
  commit: string | null;
  checkedAt: string;
}

export type CommitChange =
  | {
      op: "put";
      path: string;
      mode: "file" | "executable";
      encoding: "utf8" | "base64";
      content: string;
    }
  | { op: "delete"; path: string };

export interface CommitRequest {
  branch: string;
  /** Null: the branch must not exist yet. */
  baseCommit: string | null;
  message: string;
  changes: CommitChange[];
}

export interface CommitResult {
  commit: string;
  parent: string | null;
  branch: string;
  message: string;
  committedAt: string;
}

export interface Publication {
  id: string;
  status: "queued" | "running" | "published" | "failed";
  modulePath: string;
  commit: string;
  /** The telo version the published version runs on in Telo Cloud. */
  teloVersion?: string | null;
  ref: string | null;
  version: string | null;
  digest: string | null;
  integrity: string | null;
  identical: boolean | null;
  warnings?: string[] | null;
  error: { code: string; message?: string; details?: Record<string, unknown> } | null;
  /** The app of a published application. */
  appId?: string | null;
  /** Null when the publication asked for no deployment. */
  deploy?: PublicationDeploy | null;
}

export interface PublishedModule {
  id: string;
  modulePath: string;
  ref: string;
  visibility: "private" | "public";
  /** Sent back as `If-Match` to change the module. */
  version: number;
}

export interface PublishedModuleVersion {
  id: string;
  version: string;
  digest: string;
  integrity: string;
  commit: string;
  /** The telo version it runs on in Telo Cloud; null: the platform's own. */
  teloVersion?: string | null;
  publishedAt: string;
}

/** A refusal the API answered with: its problem body, read by `code`. Fields a
 *  refusal carries beside the code (`headCommit`, `path`, …) are in `problem`. */
export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem: Record<string, unknown>,
  ) {
    super(
      typeof problem.detail === "string"
        ? problem.detail
        : typeof problem.title === "string"
          ? problem.title
          : `Telo Cloud answered ${status} ${code}`,
    );
    this.name = "CloudApiError";
  }
}

/** What a commit, a publication or a deployment is retried on, under the same
 *  `Idempotency-Key` so the retries yield one of it. */
function retryable(err: unknown): boolean {
  if (err instanceof CloudUnreachableError) return true;
  return (
    err instanceof CloudApiError &&
    ((err.status === 502 && err.code === "repository_unreachable") ||
      (err.status === 503 && err.code === "overloaded"))
  );
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];

export interface CloudApiOptions {
  /** Called when a call is refused for want of a session, so Studio falls back
   *  to anonymous without the caller having to know. */
  onSessionLost(): void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The Telo Cloud routes Studio uses, typed. Every refusal is a
 *  `CloudApiError`; nothing here interprets one. */
export class CloudApi {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly transport: CloudTransport,
    private readonly options: CloudApiOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  listProjects(): Promise<CloudProject[]> {
    return this.listAll<CloudProject>("/v1/projects");
  }

  createProject(project: NewProject): Promise<CloudProject> {
    return this.json({ method: "POST", path: "/v1/projects", body: JSON.stringify(project) });
  }

  /** The places a new project's first stage may run on. */
  listProjectPlacements(): Promise<ProjectPlacementOption[]> {
    return this.listAll("/v1/project-placements");
  }

  /** The organization's registry namespace, or `null` until it has claimed one. */
  async getRegistryNamespace(): Promise<RegistryNamespace | null> {
    try {
      return await this.json({ method: "GET", path: "/v1/registry/namespace" });
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** The name a claim form starts from, or `null` when Cloud has none to offer. */
  async suggestRegistryNamespace(): Promise<string | null> {
    const suggestion = await this.json<{ name: string | null }>({
      method: "GET",
      path: "/v1/registry/namespace/suggestion",
    });
    return suggestion.name;
  }

  claimRegistryNamespace(name: string): Promise<RegistryNamespace> {
    return this.json({
      method: "PUT",
      path: "/v1/registry/namespace",
      body: JSON.stringify({ name }),
    });
  }

  async listStages(projectId: string): Promise<CloudStage[]> {
    const list = await this.json<{ items: CloudStage[] }>({
      method: "GET",
      path: `/v1/projects/${projectId}/stages`,
    });
    return list.items;
  }

  /** Every app of the project with its environments and what runs in each. */
  getDeploymentState(projectId: string): Promise<AppDeploymentState[]> {
    return this.listAll(`/v1/projects/${projectId}/deployment-state`);
  }

  /** The environment's deployments, newest first: the first page. */
  async listDeployments(projectId: string, environmentId: string): Promise<Deployment[]> {
    const page = await this.json<{ items: Deployment[] }>({
      method: "GET",
      path: `${environment(projectId, environmentId)}/deployments`,
    });
    return page.items;
  }

  getDeployment(projectId: string, deploymentId: string): Promise<Deployment> {
    return this.json({
      method: "GET",
      path: `/v1/projects/${projectId}/deployments/${deploymentId}`,
    });
  }

  /** Deploys a published version of the environment's app. */
  deploy(
    projectId: string,
    environmentId: string,
    version: string,
    idempotencyKey: string,
  ): Promise<Deployment> {
    return this.act(projectId, environmentId, "deployments", idempotencyKey, { version });
  }

  /** Re-applies the newest healthy deployment before the current one. */
  rollback(projectId: string, environmentId: string, idempotencyKey: string): Promise<Deployment> {
    return this.act(projectId, environmentId, "rollback", idempotencyKey, {});
  }

  /** Deploys another environment's current deployment here, as the caller saw it. */
  promote(
    projectId: string,
    environmentId: string,
    source: { sourceEnvironmentId: string; sourceDeploymentId: string },
    idempotencyKey: string,
  ): Promise<Deployment> {
    return this.act(projectId, environmentId, "promote", idempotencyKey, source);
  }

  /** Replaces every instance of what runs, changing nothing else. */
  restart(projectId: string, environmentId: string, idempotencyKey: string): Promise<Deployment> {
    return this.act(projectId, environmentId, "restart", idempotencyKey);
  }

  /** Deploys what runs again with the environment's config and secrets as they are now. */
  redeploy(projectId: string, environmentId: string, idempotencyKey: string): Promise<Deployment> {
    return this.act(projectId, environmentId, "redeploy", idempotencyKey);
  }

  cancelDeployment(projectId: string, deploymentId: string): Promise<Deployment> {
    return this.json({
      method: "POST",
      path: `/v1/projects/${projectId}/deployments/${deploymentId}/cancel`,
    });
  }

  /**
   * The deployment's events from `afterSeq` on, as Cloud sends them, until the
   * stream ends: the deployment finished, the credential the stream was opened
   * with expired, or `signal` aborted. Returns the last sequence number seen,
   * to resume from.
   */
  async streamDeploymentEvents(
    projectId: string,
    deploymentId: string,
    afterSeq: number | null,
    onEvent: (event: DeploymentEvent) => void,
    signal: AbortSignal,
  ): Promise<number | null> {
    const response = await this.send({
      method: "GET",
      path: `/v1/projects/${projectId}/deployments/${deploymentId}/events`,
      headers: {
        accept: "text/event-stream, application/problem+json",
        ...(afterSeq !== null ? { "last-event-id": String(afterSeq) } : {}),
      },
    });
    let last = afterSeq;
    // 204: nothing is left to send of a finished deployment.
    if (response.status === 204 || !response.body) return last;
    const reader = response.body.getReader();
    const cancel = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        if (signal.aborted) return last;
        const { done, value } = await reader.read();
        if (done) return last;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = deploymentEventOf(frame);
          if (!event) continue;
          last = event.seq;
          onEvent(event);
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  listConfig(projectId: string, environmentId: string): Promise<ConfigVar[]> {
    return this.listAll(`${environment(projectId, environmentId)}/config`);
  }

  setConfig(
    projectId: string,
    environmentId: string,
    key: string,
    entry: { value: string; isSecret: boolean },
  ): Promise<ConfigVar> {
    return this.json({
      method: "PUT",
      path: `${environment(projectId, environmentId)}/config/${encodeURIComponent(key)}`,
      body: JSON.stringify(entry),
    });
  }

  async deleteConfig(projectId: string, environmentId: string, key: string): Promise<void> {
    await this.send({
      method: "DELETE",
      path: `${environment(projectId, environmentId)}/config/${encodeURIComponent(key)}`,
    });
  }

  getRepository(projectId: string): Promise<CloudRepository> {
    return this.json({ method: "GET", path: `${repo(projectId)}` });
  }

  /** The branch head, or `null` when it has not moved since `etag`. */
  async getHead(
    projectId: string,
    branch: string,
    etag?: string,
  ): Promise<{ head: BranchHead; etag: string | null } | null> {
    const response = await this.send({
      method: "GET",
      path: `${repo(projectId)}/head?branch=${encodeURIComponent(branch)}`,
      headers: etag ? { "if-none-match": etag } : undefined,
    });
    if (response.status === 304) return null;
    return { head: (await response.json()) as BranchHead, etag: response.headers.get("etag") };
  }

  /** The whole tree at a commit, as the bytes of a tar. */
  async downloadSnapshot(projectId: string, commit: string): Promise<Uint8Array> {
    const response = await this.send({
      method: "GET",
      path: `${repo(projectId)}/snapshot?commit=${encodeURIComponent(commit)}`,
      headers: { accept: "application/x-tar, application/problem+json" },
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async listBranches(projectId: string): Promise<string[]> {
    const branches = await this.listAll<{ name: string }>(`${repo(projectId)}/branches`);
    return branches.map((b) => b.name);
  }

  async createBranch(projectId: string, name: string, fromCommit: string): Promise<void> {
    await this.send({
      method: "POST",
      path: `${repo(projectId)}/branches`,
      body: JSON.stringify({ name, fromCommit }),
    });
  }

  commit(
    projectId: string,
    request: CommitRequest,
    idempotencyKey: string,
  ): Promise<CommitResult> {
    return this.retrying(() =>
      this.json<CommitResult>({
        method: "POST",
        path: `${repo(projectId)}/commits`,
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(request),
      }),
    );
  }

  createPublication(
    projectId: string,
    request: {
      modulePath: string;
      commit: string;
      teloVersion: string;
      /** Deploys the published version to the module's app in this stage. */
      deploy?: { stageId: string };
    },
    idempotencyKey: string,
  ): Promise<Publication> {
    return this.retrying(() =>
      this.json<Publication>({
        method: "POST",
        path: `/v1/projects/${projectId}/publications`,
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(request),
      }),
    );
  }

  getPublication(projectId: string, publicationId: string): Promise<Publication> {
    return this.json({
      method: "GET",
      path: `/v1/projects/${projectId}/publications/${publicationId}`,
    });
  }

  listModules(projectId: string): Promise<PublishedModule[]> {
    return this.listAll(`/v1/projects/${projectId}/modules`);
  }

  listModuleVersions(projectId: string, moduleId: string): Promise<PublishedModuleVersion[]> {
    return this.listAll(`/v1/projects/${projectId}/modules/${moduleId}/versions`);
  }

  setModuleVisibility(
    projectId: string,
    module: Pick<PublishedModule, "id" | "version">,
    visibility: "private" | "public",
  ): Promise<PublishedModule> {
    return this.json({
      method: "PATCH",
      path: `/v1/projects/${projectId}/modules/${module.id}`,
      headers: { "if-match": `"${module.version}"` },
      body: JSON.stringify({ visibility }),
    });
  }

  /** One of an environment's deployment actions: each answers the deployment it created. */
  private act(
    projectId: string,
    environmentId: string,
    action: "deployments" | "rollback" | "promote" | "restart" | "redeploy",
    idempotencyKey: string,
    body?: unknown,
  ): Promise<Deployment> {
    return this.retrying(() =>
      this.json<Deployment>({
        method: "POST",
        path: `${environment(projectId, environmentId)}/${action}`,
        headers: { "idempotency-key": idempotencyKey },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }

  private async retrying<T>(attempt: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (err) {
        const delay = RETRY_DELAYS_MS[i];
        if (delay === undefined || !retryable(err)) throw err;
        await this.sleep(delay);
      }
    }
  }

  /** Every page of a `{ items, nextCursor }` collection. */
  private async listAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const separator = path.includes("?") ? "&" : "?";
      const page: { items: T[]; nextCursor: string | null } = await this.json({
        method: "GET",
        path: cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path,
      });
      if (!Array.isArray(page.items)) {
        throw new Error(`Telo Cloud answered ${path} without a list of items.`);
      }
      items.push(...page.items);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return items;
  }

  private async json<T>(request: CloudRequest): Promise<T> {
    return (await (await this.send(request)).json()) as T;
  }

  /** Sends, and turns every answer that is not a success (or a 304) into a
   *  `CloudApiError`. */
  private async send(request: CloudRequest): Promise<Response> {
    const response = await this.transport.request(request);
    if (response.ok || response.status === 304) return response;
    let problem: Record<string, unknown> = {};
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null) problem = body as Record<string, unknown>;
    } catch {
      // Not a problem document: the status is all there is to report.
    }
    const code = typeof problem.code === "string" ? problem.code : `http_${response.status}`;
    if (response.status === 401) this.options.onSessionLost();
    throw new CloudApiError(response.status, code, problem);
  }
}

function repo(projectId: string): string {
  return `/v1/projects/${projectId}/repository`;
}

function environment(projectId: string, environmentId: string): string {
  return `/v1/projects/${projectId}/environments/${environmentId}`;
}

/** The event of one frame of the stream; a keepalive comment carries none. */
function deploymentEventOf(frame: string): DeploymentEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data === "") return null;
  try {
    const event = JSON.parse(data) as DeploymentEvent;
    return typeof event.seq === "number" && typeof event.status === "string" ? event : null;
  } catch {
    return null;
  }
}
