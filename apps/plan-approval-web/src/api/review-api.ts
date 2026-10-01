// The review surface (`/api/review/`), same-origin. The UI never calls the agent
// surface. Shapes follow apps/plan-approval/README.md.

export const PLAN_STATES = [
  "submitted",
  "changes_requested",
  "revised",
  "approved",
  "rejected",
  "withdrawn",
  "in_progress",
  "completed",
  "parked",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export type Decision = "approve" | "request_changes" | "reject";

export interface Plan {
  id: string;
  product: string;
  repo: string;
  branch: string;
  loop: string;
  title: string;
  state: PlanState;
  session: string | null;
  runner: string | null;
  latestRevision: { seq: number; hash: string; items: string[]; createdAt: string };
  approvedSeq: number | null;
  approvedHash: string | null;
  cursor: number;
  createdAt: string;
  updatedAt: string;
  overdue: boolean;
}

export interface Revision {
  seq: number;
  hash: string;
  summary: string | null;
  items: string[];
  session: string | null;
  body: string;
  createdAt: string;
}

export interface TimelineEvent {
  seq: number;
  type: string;
  source: "agent" | "reviewer";
  author: string | null;
  revision: number | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Link {
  type: "branch" | "pull-request" | "commit";
  url: string;
  status: string;
  reportedAt: string;
}

export interface PlanDetail {
  plan: Plan;
  revisions: Revision[];
  events: TimelineEvent[];
  links: Link[];
  lastReviewedRevision: number;
}

export interface Delivery {
  outboxId: number;
  event: string;
  planId: string;
  attempt: number;
  status: number | null;
  error: string | null;
  at: string;
}

export interface Product {
  slug: string;
  name: string;
  deadline: string | null;
  webhookUrl: string | null;
  createdAt: string;
  pendingDeliveries: number;
  deliveries: Delivery[];
}

export interface Repo {
  slug: string;
  url: string;
  products: string[];
  createdAt: string;
}

export interface Runner {
  name: string;
  lastSeenAt: string;
  repos: string[];
  activeSessions: { id: string; repo: string }[];
}

export interface RunnerSession {
  id: string;
  repo: string;
  state: "active" | "inactive";
  firstSeenAt: string;
  lastSeenAt: string | null;
  plans: string[];
}

export interface RunnerCommand {
  seq: number;
  type: "wake" | "start" | "stop";
  state: "pending" | "done" | "failed" | "superseded";
  session: string | null;
  sessionName: string | null;
  repo: string;
  plan: string | null;
  planSeq: number | null;
  decision: Decision | null;
  prompt: string | null;
  author: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
}

/** A refusal from the server, carrying its `code`, message and any `data`. */
export class ReviewApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "ReviewApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/review${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ReviewApiError(
        response.status,
        undefined,
        `${method} ${path} answered ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`,
        undefined,
      );
    }
  }
  if (!response.ok) {
    // Coded refusals are `{error, code, data?}`; schema refusals are
    // `{error: "ValidationError", message, details: [{message}]}`.
    const failure = (parsed ?? {}) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
      data?: unknown;
      details?: unknown;
    };
    const lead =
      typeof failure.message === "string"
        ? failure.message
        : typeof failure.error === "string"
          ? failure.error
          : `${method} ${path} failed with status ${response.status}.`;
    const details = Array.isArray(failure.details)
      ? failure.details.map((d: { message?: unknown }) => (typeof d?.message === "string" ? d.message : JSON.stringify(d)))
      : [];
    const code =
      typeof failure.code === "string"
        ? failure.code
        : typeof failure.message === "string" && typeof failure.error === "string"
          ? failure.error
          : undefined;
    throw new ReviewApiError(response.status, code, [lead, ...details].join("\n"), failure.data);
  }
  return parsed as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/** A page of a runner's commands or sessions: `after` and `before` bound the
 *  key exclusively, and the answer's `cursor` is the last key in page order. */
export interface ListPageQuery {
  order?: "asc" | "desc";
  after?: number;
  before?: number;
  limit?: number;
}

export interface InboxFilter {
  product?: string;
  repo?: string;
  status?: string;
  age?: string;
}

export const reviewApi = {
  listPlans: (filter: InboxFilter) => request<{ plans: Plan[] }>("GET", `/plans${query({ ...filter })}`),
  planDetail: (id: string) => request<PlanDetail>("GET", `/plans/${encodeURIComponent(id)}`),
  comment: (id: string, body: { author: string; body: string; revision: number; item?: string }) =>
    request<{ planId: string; seq: number }>("POST", `/plans/${encodeURIComponent(id)}/comments`, body),
  decide: (
    id: string,
    body: { author: string; decision: Decision; revision: number; hash: string; note?: string },
  ) => request<{ planId: string; state: PlanState; cursor: number }>("POST", `/plans/${encodeURIComponent(id)}/decisions`, body),

  listProducts: () => request<{ products: Product[] }>("GET", "/products"),
  createProduct: (body: { slug: string; name: string; deadline?: string; webhookUrl?: string }) =>
    request<Product>("POST", "/products", body),
  updateProduct: (slug: string, body: { name: string; deadline?: string; webhookUrl?: string }) =>
    request<Product>("PUT", `/products/${encodeURIComponent(slug)}`, body),
  listRepos: () => request<{ repos: Repo[] }>("GET", "/repos"),
  createRepo: (body: { slug: string; url: string; products: string[] }) => request<Repo>("POST", "/repos", body),

  listRunners: () => request<{ runners: Runner[] }>("GET", "/runners"),
  runnerSessions: (name: string, page: ListPageQuery & { state?: "active" | "inactive" }) =>
    request<{ sessions: RunnerSession[]; cursor: number }>(
      "GET",
      `/runners/${encodeURIComponent(name)}/sessions${query({ ...page })}`,
    ),
  runnerCommands: (name: string, page: ListPageQuery) =>
    request<{ commands: RunnerCommand[]; cursor: number }>(
      "GET",
      `/runners/${encodeURIComponent(name)}/commands${query({ ...page })}`,
    ),
  startSession: (name: string, body: { author: string; repo: string; prompt: string }) =>
    request<{ seq: number }>("POST", `/runners/${encodeURIComponent(name)}/commands`, { ...body, type: "start" }),
  stopSession: (name: string, body: { author: string; session: string }) =>
    request<{ seq: number }>("POST", `/runners/${encodeURIComponent(name)}/commands`, { ...body, type: "stop" }),
};

/** Export routes, linked rather than fetched: the browser downloads the JSON. */
export const historyUrl = {
  plan: (id: string) => `/api/review/plans/${encodeURIComponent(id)}/history`,
  product: (slug: string) => `/api/review/products/${encodeURIComponent(slug)}/history`,
};
