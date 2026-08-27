import type { WorkspaceAccess } from "../backend.js";
import type {
  WorkspaceChangeSet,
  WorkspaceCheckpointFile,
  WorkspaceTree,
} from "../contract.js";

/**
 * HTTP client for the `workspace` container's surface, shared by both backends:
 * the container is the same image running the same manifest whether it is a
 * sibling container on a docker network or a container in a kubernetes pod, so
 * only the base URL differs.
 *
 * The runner reaches it over its own network (a pod IP, a container address) and
 * proxies it outward. It is never published.
 */
export class WorkspaceClient implements WorkspaceAccess {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async tree(): Promise<WorkspaceTree> {
    return this.request<WorkspaceTree>("GET", "/workspace");
  }

  async readFile(path: string): Promise<{ content: string; size: number }> {
    return this.request<{ content: string; size: number }>(
      "GET",
      `/workspace/file?path=${encodeURIComponent(path)}`,
    );
  }

  async apply(changes: WorkspaceChangeSet): Promise<{ written: number; deleted: number }> {
    return this.request<{ written: number; deleted: number }>("POST", "/workspace", changes);
  }

  async snapshot(): Promise<WorkspaceCheckpointFile[]> {
    const body = await this.request<{ files: WorkspaceCheckpointFile[] }>(
      "GET",
      "/workspace/snapshot",
    );
    return body.files;
  }

  /** Re-run one app with no file change: rewrite its entry manifest with the
   *  bytes it already holds, through the same write path everything else takes.
   *  That is what makes `reload` need no signalling into the container, no
   *  shared PID namespace and no `exec` — RBAC is unchanged. */
  async touch(path: string): Promise<void> {
    const file = await this.request<{ content: string }>(
      "GET",
      `/workspace/file?path=${encodeURIComponent(path)}&encoding=base64`,
    );
    await this.apply({ write: [{ path, content: file.content, encoding: "base64" }] });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) {
        // Surfaced, never swallowed: a workspace that has stopped answering is
        // the one failure that makes every later edit silently do nothing.
        throw new Error(`workspace ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`);
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
