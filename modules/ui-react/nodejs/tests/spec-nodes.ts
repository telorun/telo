import type { SpecNode } from "../src/browser/nodes.js";
import { uiText } from "./ui-texts.js";

/** The row model the test pages are built over. */
export const todoSchema = {
  type: "object",
  required: ["text"],
  properties: {
    id: { type: "integer" },
    text: { type: "string", title: "Task", minLength: 2 },
    isDone: { type: "boolean", title: "Done" },
    priority: { type: "integer", title: "Priority", minimum: 1, maximum: 5 },
    status: { title: "Status", enum: ["open", "blocked", "done"] },
    dueOn: { type: "string", title: "Due", format: "date" },
    notes: { type: "string", title: "Notes", contentMediaType: "text/plain" },
  },
};

export const todos = [
  { id: 1, text: "Write the plan", isDone: true, priority: 2, status: "done", dueOn: "2026-10-01" },
  { id: 2, text: "Review the plan", isDone: false, priority: 1, status: "open", dueOn: "2026-10-07" },
  { id: 3, text: "Ship the renderer", isDone: false, priority: 3, status: "blocked", dueOn: "2026-10-09" },
  { id: 4, text: "Write the docs", isDone: false, priority: 2, status: "open", dueOn: "2026-10-12" },
  { id: 5, text: "Record the demo", isDone: false, priority: 5, status: "open", dueOn: "2026-10-15" },
];

const row = (...path: string[]) => ({ root: "row", path });

/** An address as `ui` provides it: every member present; a literal path is a template. */
export const address = (path: string | { root: string; path: string[] }, pathParams: Record<string, unknown> = {}, queryParams: Record<string, unknown> = {}) => ({
  path: typeof path === "string" ? { value: path } : path,
  pathParams,
  queryParams,
});

/** A destination moving to an address, as `ui` provides a `Ui.Navigate`. */
export const navigateTo = (href: ReturnType<typeof address>) => ({ type: "navigate", href });

/** A destination opening a page over the current one, as `ui` provides a `Ui.OpenPage`: in a dialog that keeps the surface it is pressed in unless told. */
export const openPageAt = (href: ReturnType<typeof address>, surface: Record<string, unknown> = dialogSurface, keepsSurface = true) => ({ type: "openPage", href, surface, keepsSurface });

/** The properties of the test model a form enters. */
const todoProperties = ["text", "isDone", "priority", "status", "dueOn", "notes"];

/**
 * A form as `ui` provides it, every member present: by default one that creates
 * a record in `basePath` from nothing, closing once it is saved. `overrides` replace members.
 */
export const formNode = (basePath = "/api/todos", overrides: Record<string, unknown> = {}): SpecNode => ({
  type: "form",
  schema: todoSchema,
  record: { basePath, key: null },
  initialValues: null,
  unsaved: "confirm",
  afterSubmit: "close",
  fields: todoProperties.map((property) => ({
    type: "input",
    property,
    label: (todoSchema.properties as Record<string, { title?: string }>)[property].title ?? property,
    control: "auto",
  })),
  groups: [],
  state: memoryState(todoProperties),
  ...overrides,
});

/** The form that edits the record the page's query read: keyed by the page's `id` variable, starting from `data`. */
export const editFormNode = (basePath = "/api/todos", overrides: Record<string, unknown> = {}): SpecNode =>
  formNode(basePath, { record: { basePath, key: { root: "params", path: ["id"] } }, initialValues: { root: "data", path: [] }, ...overrides });

/** The edit page's read of one record: `/api/todos/{id}` by the page's `id`, drawing `content`. */
export const recordQuery = (content: SpecNode[], basePath = "/api/todos", schema: Record<string, unknown> = todoSchema): SpecNode => ({
  type: "query",
  query: {
    id: "record",
    schema,
    method: "GET",
    url: address(`${basePath}/{id}`, { id: { root: "params", path: ["id"] } }),
    input: null,
    query: {},
    reloadOn: [],
  },
  content,
  loading: [{ type: "text", text: "Loading…", style: "muted" }],
  failure: [defaultFailure],
  fill: false,
});

/** An edit page over `basePath`: the record read by the page's `id`, its form over `schema` with these members replaced. */
export const recordEditPage = (basePath: string, schema: Record<string, unknown>, form: Record<string, unknown>): { title: string; children: SpecNode[] } => ({
  title: "Record",
  children: [
    recordQuery(
      [formNode(basePath, { schema, record: { basePath, key: { root: "params", path: ["id"] } }, initialValues: { root: "data", path: [] }, ...form })],
      basePath,
      schema,
    ),
  ],
});

/**
 * The two pages a collection's records are written on: `/todos/new` holding a
 * form that creates, `/todos/{id}` reading the record and holding a form that
 * edits it. `create` and `edit` replace members of each form.
 */
export const recordPages = (create: Record<string, unknown> = {}, edit: Record<string, unknown> = {}): Record<string, { title?: string; query?: Record<string, unknown>; children: SpecNode[] }> => ({
  "/todos/new": { children: [formNode("/api/todos", create)] },
  "/todos/{id}": { children: [recordQuery([editFormNode("/api/todos", edit)])] },
});

/**
 * `recordPages` whose create page declares the `status` and `dueOn` query parameters and starts its form from them,
 * as a page does that a layout's create gesture proposes values to.
 */
export const prefilledPages = (create: Record<string, unknown> = {}): ReturnType<typeof recordPages> => {
  const pages = recordPages({ initialValues: { root: "query", path: [] }, ...create });
  return { ...pages, "/todos/new": { ...pages["/todos/new"], query: { status: { type: "string" }, dueOn: { type: "string" } } } };
};

/** A press whose destination opens a page in `surface`, named as `ui` names a listing's `create` and `edit`. */
export const pressOpening = (kind: "create" | "edit", surface: Record<string, unknown> = dialogSurface, keepsSurface = false, queryParams: Record<string, unknown> = {}): Record<string, unknown> => ({
  to: openPageAt(kind === "create" ? address("/todos/new", {}, queryParams) : address("/todos/{id}", { id: row("id") }, queryParams), surface, keepsSurface),
  label: uiText(kind),
});

/** The `create` and `edit` of a listing that open `recordPages` in these surfaces; `press` follows `edit`, as `ui` fills it. */
export const recordPresses = (surface: Record<string, unknown> = dialogSurface, editSurface: Record<string, unknown> = surface): Record<string, unknown> => {
  const edit = pressOpening("edit", editSurface);
  return { create: pressOpening("create", surface), edit, press: edit };
};

/** A record kept in memory: what a form or an action without `state` carries. */
export const memoryState = (fields: string[]) => ({ address: false, store: { type: "memory" }, fields });

export const component = (name: string, props: Record<string, unknown> = {}): SpecNode => ({
  type: "component",
  module: { digest: "cc", name: "components.js" },
  export: name,
  abi: "ui_react-1",
  external: ["react"],
  stylesheets: [{ digest: "cc", name: "components.css" }],
  props,
});

export const dialogSurface = { type: "dialog", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } };

/** The columns of the test listing's table. */
export const todoColumns = [
  { header: "Task", value: row("text"), sort: "text", present: { type: "string" }, labels: [] },
  { header: "Priority", value: row("priority"), sort: "priority", present: { type: "integer" }, labels: [], style: { by: row("priority"), cases: { "1": "danger" }, default: "strong" } },
  { header: "Due", value: row("dueOn"), sort: "dueOn", present: { type: "string", format: "date" }, labels: [] },
  { header: "State", cell: component("StatusPill", { done: row("isDone") }), labels: [] },
];

/**
 * A listing as `ui` provides it, drawn as a table: every member it fills
 * filled. `columns` is laid into the table layout, and `layout` replaces it.
 */
export const listingNode = ({ columns = todoColumns, layout, ...overrides }: Record<string, any> = {}): SpecNode => ({
  type: "listing",
  schema: todoSchema,
  basePath: "/api/todos",
  key: "id",
  query: {},
  pageSize: 2,
  paging: "pages",
  sort: { sortable: ["text", "priority", "dueOn"], initial: null },
  show: { count: true },
  rowStyle: { by: row("isDone"), cases: { true: "muted" } },
  create: pressOpening("create"),
  edit: pressOpening("edit"),
  delete: true,
  rowActions: [],
  rowActionsDisplay: "auto",
  relations: {},
  empty: { type: "text", text: uiText("noRows") },
  layout: layout ?? { type: "table", columns, reads: {} },
  press: null,
  ...overrides,
});

/** One filter of a bar, over the test model: neither pinned nor given a control unless told. */
export const filterField = (property: keyof typeof todoSchema.properties, operator: string, more: Record<string, unknown> = {}) => ({
  property,
  operator,
  label: (todoSchema.properties[property] as { title?: string }).title ?? property,
  schema: todoSchema.properties[property],
  pinned: false,
  control: "auto",
  values: "all",
  ...more,
});

/** What a placement that draws controls carries beside its own members. */
export const display = { show: "all", controls: "direct", summary: "none" } as const;

/** A filter bar with the policy a bar that declares none carries. */
export const filtersNode = (content: SpecNode, overrides: Record<string, unknown> = {}): SpecNode => ({
  type: "filters",
  basePath: "/api/todos",
  fields: [
    filterField("text", "contains"),
    filterField("isDone", "eq"),
    filterField("status", "in"),
    filterField("priority", "gte"),
    filterField("dueOn", "gte"),
    filterField("dueOn", "lte"),
  ],
  content,
  placement: { type: "above", ...display },
  apply: "commit",
  state: { address: false, store: { type: "memory" }, fields: Object.keys(todoSchema.properties) },
  presets: [],
  ...overrides,
});

/** The input model of the test action: a scalar of each kind a list is made of, and both lists. */
export const reportSchema = {
  type: "object",
  required: ["month"],
  properties: {
    month: { type: "string", title: "Month", pattern: "^[0-9]{4}-[0-9]{2}$" },
    copies: { type: "integer", title: "Copies", minimum: 1 },
    formats: { type: "array", title: "Formats", items: { enum: ["pdf", "csv"] } },
    recipients: { type: "array", title: "Recipients", items: { type: "string", minLength: 3 } },
  },
};

const result = (...path: string[]) => ({ root: "result", path });

/** What `ui` fills a left-out `failure` tree with: the error's code and message. */
export const defaultFailure = {
  type: "stack",
  style: "danger",
  children: [
    { type: "value", value: { root: "error", path: ["code"] }, present: { type: "string" }, style: "strong" },
    { type: "value", value: { root: "error", path: ["message"] }, present: { type: "string" } },
  ],
};

/** An operation as `ui` provides it, every member it fills filled. */
export const operation = (path: string, label: string, schema: Record<string, unknown>, overrides: Record<string, unknown> = {}): SpecNode => ({
  type: "action",
  schema,
  request: { method: "POST", target: address(path), consumed: [] },
  label,
  fields: Object.entries((schema.properties ?? {}) as Record<string, { title?: string }>).map(([property, { title }]) => ({
    type: "input",
    property,
    label: title ?? property,
    control: "auto",
  })),
  groups: [],
  state: memoryState(Object.keys(schema.properties ?? {})),
  failure: defaultFailure,
  onSuccess: { refreshes: [] },
  concurrency: "parallel",
  clearAnswerOn: [],
  ...overrides,
});

/** An action over the report model that draws the files of its answer, then its totals. */
export const actionNode = (overrides: Record<string, unknown> = {}): SpecNode =>
  operation("/api/reports", "Generate", reportSchema, {
    result: {
      type: "stack",
      children: [
        {
          type: "list",
          heading: "Files",
          rows: result("files"),
          columns: [
            { header: "File", value: row("name"), present: { type: "string" } },
            { header: "Download", value: row("url"), present: { type: "string", format: "uri-reference" } },
            { header: "Month", value: result("month"), present: { type: "string" } },
            { header: "Kind", value: { value: "report" } },
          ],
        },
        { type: "list", rows: result("totals"), columns: [{ header: "Made", value: row("at"), present: { type: "string", format: "date" } }] },
      ],
    },
    ...overrides,
  });

/** The record of the test reader: who is signed in, and their files. */
export const accountSchema = {
  type: "object",
  required: ["authorized"],
  properties: {
    authorized: { type: "boolean" },
    email: { type: "string" },
    files: { type: "array", items: { type: "object", properties: { name: { type: "string" }, url: { type: "string", format: "uri-reference" } } } },
  },
};

const data = (...path: string[]) => ({ root: "data", path });

/** A query as `ui` provides it, every member present: the account at `/api/account`, read by `GET`. */
export const querySpec = (overrides: Record<string, unknown> = {}) => ({
  id: "account",
  schema: accountSchema,
  method: "GET",
  url: address("/api/account"),
  input: null,
  query: {},
  reloadOn: [],
  ...overrides,
});

/** A query node over `/api/account`: the email and the files while signed in,
 *  a banner otherwise; defaults for its loading and failure lists. `query`
 *  overrides members of the query it draws. */
export const queryNode = (overrides: Record<string, unknown> = {}, query: Record<string, unknown> = {}): SpecNode => ({
  type: "query",
  query: querySpec(query),
  content: [
    {
      type: "stack",
      children: [
        { type: "value", value: data("email"), present: { type: "string" }, shown: { at: data("authorized"), matches: { const: true } } },
        {
          type: "list",
          heading: "Files",
          rows: data("files"),
          columns: [{ header: "Name", value: row("name"), present: { type: "string" } }],
          shown: { at: data("authorized"), matches: { const: true } },
        },
        { type: "text", text: "Sign in first.", shown: { at: data("authorized"), matches: { const: false } } },
      ],
    },
  ],
  loading: [{ type: "text", text: "Loading…", style: "muted" }],
  failure: [defaultFailure],
  fill: false,
  ...overrides,
});

/** A plan review's comment on an item of a revision: the person enters who and what. */
export const commentSchema = {
  type: "object",
  required: ["id", "revision", "author", "body"],
  properties: {
    id: { type: "string" },
    revision: { type: "integer" },
    item: { type: "string" },
    author: { type: "string", title: "Your name", minLength: 1 },
    body: { type: "string", title: "Comment", minLength: 1 },
  },
};

/** A plan review's decision on a revision. */
export const decisionSchema = {
  type: "object",
  required: ["id", "decision", "revision", "author"],
  properties: {
    id: { type: "string" },
    decision: { enum: ["approve", "request_changes"] },
    revision: { type: "integer" },
    author: { type: "string", title: "Your name", minLength: 1 },
    note: { type: "string", title: "Note", minLength: 1 },
  },
};

/** The state a review's actions keep `author` in, under one key in the local store. */
export const reviewerState = (fields: string[]) => ({ key: "reviewer", address: false, store: { type: "local" }, fields });

/** The prompt `ui` gives a bound action: a field per property the inputs leave. */
export const promptOf = (action: SpecNode, properties: string[]) => ({
  fields: (action.fields as { property: string }[]).filter((field) => properties.includes(field.property)),
});

/** The `Aside` shape a split view and a page layout hold, every member present. */
export const asideOf = (content: SpecNode, overrides: Record<string, unknown> = {}) => ({
  side: "start",
  size: "medium",
  frame: "flush",
  toggle: { type: "text" },
  label: "Shortcuts",
  collapse: null,
  compact: { type: "drawer", side: "start", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } },
  actions: [],
  content,
  ...overrides,
});
