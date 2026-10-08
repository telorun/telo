// A hand-written collection that speaks the contract a `Ui.Table` source
// reads. The logic is a plain function of a request, so a test can call it
// with no server; the mount below puts it on one.

const OPERATORS = ["contains", "gt", "gte", "lt", "lte", "in"];

const invalid = (location, path, message) => ({
  status: 400,
  body: { error: "ValidationError", message: "Request validation failed", status: 400, details: [{ location, path, message }] },
});

const compare = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? "")));

/** `{ handle({ method, path, query, body }) → { status, body } }` over `rows`,
 *  where `path` is what follows the base path and `query` a URLSearchParams. */
export function createCollection(seed, required = []) {
  let rows = seed.map((row) => ({ ...row }));
  let nextId = Math.max(0, ...rows.map((row) => Number(row.id) || 0)) + 1;
  const properties = () => new Set(rows.flatMap((row) => Object.keys(row)).concat(required, ["id"]));

  const list = (query) => {
    const limit = query.has("limit") ? Number(query.get("limit")) : 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return invalid("query", "limit", "must be an integer from 1 to 100");
    let selected = [...rows].sort((a, b) => compare(a.id, b.id));
    const names = [...new Set(query.keys())];
    for (const name of names) {
      // Keys beginning `_telo` are the renderer's own.
      if (["limit", "cursor", "sort"].includes(name) || name.startsWith("_telo")) continue;
      const dot = name.lastIndexOf(".");
      const operator = dot > 0 && OPERATORS.includes(name.slice(dot + 1)) ? name.slice(dot + 1) : "eq";
      const property = operator === "eq" ? name : name.slice(0, dot);
      if (!properties().has(property)) return invalid("query", name, "names no property of this collection");
      const values = query.getAll(name);
      const against = (row) => (typeof row[property] === "number" ? Number(values[0]) : values[0]);
      selected = selected.filter((row) => {
        const value = row[property];
        if (operator === "eq") return String(value) === values[0];
        if (operator === "in") return values.includes(String(value));
        if (operator === "contains") return String(value ?? "").toLowerCase().includes(values[0].toLowerCase());
        const order = compare(value, against(row));
        return operator === "gt" ? order > 0 : operator === "gte" ? order >= 0 : operator === "lt" ? order < 0 : order <= 0;
      });
    }
    if (query.has("sort")) {
      const sort = query.get("sort");
      const property = sort.replace(/^-/, "");
      if (!properties().has(property)) return invalid("query", "sort", "names no property of this collection");
      selected.sort((a, b) => compare(a[property], b[property]) * (sort.startsWith("-") ? -1 : 1));
    }
    const offset = query.has("cursor") ? Number(Buffer.from(query.get("cursor"), "base64url").toString()) : 0;
    if (!Number.isInteger(offset) || offset < 0) return invalid("query", "cursor", "is not a cursor this collection issued");
    const end = offset + limit;
    return {
      status: 200,
      body: {
        rows: selected.slice(offset, end),
        total: selected.length,
        next: end < selected.length ? Buffer.from(String(end)).toString("base64url") : null,
      },
    };
  };

  const missing = (record) => required.find((name) => record?.[name] === undefined || record[name] === "");

  return {
    handle({ method, path, query, body }) {
      const key = decodeURIComponent(path.replace(/^\//, ""));
      if (key === "") {
        if (method === "GET") return list(query);
        if (method === "POST") {
          const absent = missing(body);
          if (absent) return invalid("body", absent, "is a required property");
          const row = { ...body, id: nextId++ };
          rows.push(row);
          return { status: 201, body: row };
        }
      }
      const index = rows.findIndex((row) => String(row.id) === key);
      if (index === -1) return { status: 404, body: { error: "NotFound", message: `No row '${key}'.`, status: 404 } };
      if (method === "GET") return { status: 200, body: rows[index] };
      if (method === "PUT") {
        const absent = missing(body);
        if (absent) return invalid("body", absent, "is a required property");
        rows[index] = { ...body, id: rows[index].id };
        return { status: 200, body: rows[index] };
      }
      if (method === "DELETE") {
        rows.splice(index, 1);
        return { status: 204, body: undefined };
      }
      return { status: 405, body: { error: "MethodNotAllowed", message: `${method} is not served here.`, status: 405 } };
    },
  };
}

export const Collection = {
  async create(resource) {
    const collection = createCollection(resource.rows, resource.required ?? []);
    return {
      register(app, prefix) {
        const base = prefix.replace(/\/+$/, "");
        const serve = (request, reply) => {
          const url = new URL(request.url, "http://telo.invalid");
          const answer = collection.handle({
            method: request.method,
            path: url.pathname.slice(base.length),
            query: url.searchParams,
            body: request.body,
          });
          reply.code(answer.status);
          return answer.body === undefined ? reply.send() : reply.send(answer.body);
        };
        app.route({ method: ["GET", "POST"], url: base === "" ? "/" : base, handler: serve });
        app.route({ method: ["GET", "PUT", "DELETE"], url: `${base}/:id`, handler: serve });
      },
    };
  },
};
