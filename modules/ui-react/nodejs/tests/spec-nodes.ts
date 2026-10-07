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

export const tableNode = (overrides: Record<string, unknown> = {}): SpecNode => ({
  type: "table",
  schema: todoSchema,
  basePath: "/api/todos",
  rowKey: "id",
  pageSize: 2,
  delete: true,
  create: formNode(),
  edit: formNode(),
  rowStyle: { by: row("isDone"), cases: { true: "muted" } },
  columns: [
    { header: "Task", value: row("text"), sort: "text", present: { type: "string" } },
    { header: "Priority", value: row("priority"), sort: "priority", present: { type: "integer" }, style: { by: row("priority"), cases: { "1": "danger" }, default: "strong" } },
    { header: "Due", value: row("dueOn"), sort: "dueOn", present: { type: "string", format: "date" } },
    { header: "State", cell: component("StatusPill", { done: row("isDone") }) },
  ],
  ...overrides,
});

export const filtersNode = (content: SpecNode): SpecNode => ({
  type: "filters",
  fields: [
    { property: "text", operator: "contains", label: "Task", schema: todoSchema.properties.text },
    { property: "isDone", operator: "eq", label: "Done", schema: todoSchema.properties.isDone },
    { property: "status", operator: "in", label: "Status", schema: todoSchema.properties.status },
    { property: "priority", operator: "gte", label: "Priority", schema: todoSchema.properties.priority },
  ],
  content,
});
