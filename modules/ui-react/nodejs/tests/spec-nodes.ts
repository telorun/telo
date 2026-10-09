import type { SpecNode } from "../src/browser/nodes.js";

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

export const formNode = (basePath = "/api/todos"): SpecNode => ({
  type: "form",
  schema: todoSchema,
  basePath,
  fields: ["text", "isDone", "priority", "status", "dueOn", "notes"].map((property) => ({
    property,
    label: (todoSchema.properties as Record<string, { title?: string }>)[property].title ?? property,
  })),
});

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

/** How a table opens a form: a dialog with its defaults unless overridden. */
export const opener = (overrides: Record<string, unknown> = {}) => ({
  form: formNode(),
  surface: dialogSurface,
  afterSubmit: "close",
  unsaved: "confirm",
  ...overrides,
});

export const tableNode = (overrides: Record<string, unknown> = {}): SpecNode => ({
  type: "table",
  schema: todoSchema,
  basePath: "/api/todos",
  rowKey: "id",
  pageSize: 2,
  rowActions: [],
  delete: true,
  create: opener(),
  edit: opener(),
  rowStyle: { by: row("isDone"), cases: { true: "muted" } },
  columns: [
    { header: "Task", value: row("text"), sort: "text", present: { type: "string" } },
    { header: "Priority", value: row("priority"), sort: "priority", present: { type: "integer" }, style: { by: row("priority"), cases: { "1": "danger" }, default: "strong" } },
    { header: "Due", value: row("dueOn"), sort: "dueOn", present: { type: "string", format: "date" } },
    { header: "State", cell: component("StatusPill", { done: row("isDone") }) },
  ],
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
  ...more,
});

/** A filter bar with the policy a bar that declares none carries. */
export const filtersNode = (content: SpecNode, overrides: Record<string, unknown> = {}): SpecNode => ({
  type: "filters",
  fields: [
    filterField("text", "contains"),
    filterField("isDone", "eq"),
    filterField("status", "in"),
    filterField("priority", "gte"),
    filterField("dueOn", "gte"),
    filterField("dueOn", "lte"),
  ],
  content,
  show: "all",
  placement: { type: "above" },
  controls: "direct",
  apply: "commit",
  summary: "none",
  state: { address: false, store: { type: "memory" } },
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

/** An action over the report model that draws the files of its answer, then its totals. */
export const actionNode = (overrides: Record<string, unknown> = {}): SpecNode => ({
  type: "action",
  schema: reportSchema,
  path: "/api/reports",
  label: "Generate",
  fields: Object.entries(reportSchema.properties).map(([property, { title }]) => ({ property, label: title })),
  lists: [
    {
      heading: "Files",
      rows: result("files"),
      columns: [
        { header: "File", value: row("name"), present: { type: "string" } },
        { header: "Download", value: row("url"), present: { type: "string", format: "uri-reference" } },
        { header: "Month", value: result("month"), present: { type: "string" } },
        { header: "Kind", value: { value: "report" } },
      ],
    },
    { rows: result("totals"), columns: [{ header: "Made", value: row("at"), present: { type: "string", format: "date" } }] },
  ],
  ...overrides,
});
