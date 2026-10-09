import { CloudUnreachableError, type CloudRequest, type CloudTransport } from "./transport";

export type ProjectRole = "admin" | "deployer" | "viewer";

export interface CloudProject {
  id: string;
  name: string;
  slug: string;
  effectiveRole: ProjectRole;
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
  ref: string | null;
  version: string | null;
  digest: string | null;
  integrity: string | null;
  identical: boolean | null;
  warnings?: string[] | null;
  error: { code: string; message?: string; details?: Record<string, unknown> } | null;
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

/** What a commit or a publication is retried on, under the same
 *  `Idempotency-Key` so the retries yield one commit. */
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
    request: { modulePath: string; commit: string },
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
