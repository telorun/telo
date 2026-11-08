import Database from "better-sqlite3";
import Fastify, { type FastifyError } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { heavy, light, medium, type Derived, type Lead } from "./levels.js";

const stateDir = process.env.STATE_DIR;
if (!stateDir) throw new Error("STATE_DIR is not set");
const port = Number(process.env.PORT ?? 8845);

const SEED =
  '{"id":"seed","level":"light","lead":{"email":"seed@example.com","company":{"name":"Seed Co","employees":12,"country":"US","industry":"saas"},"plan":"starter"},"derived":{"domain":"example.com","personal":false,"sizeBand":"smb","planTier":2,"score":25}}';

mkdirSync(stateDir, { recursive: true });
const db = new Database(join(stateDir, "leads.db"));
db.exec("CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
db.prepare("INSERT OR IGNORE INTO leads (id, body) VALUES ('seed', ?)").run(SEED);
const insert = db.prepare("INSERT INTO leads (id, body) VALUES (?, ?)");
const select = db.prepare("SELECT body FROM leads WHERE id = ?");

const leadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "company", "plan"],
  if: { properties: { plan: { const: "enterprise" } }, required: ["plan"] },
  then: { properties: { company: { properties: { employees: { minimum: 50 } } } } },
  properties: {
    email: { type: "string", format: "email" },
    company: {
      type: "object",
      additionalProperties: false,
      required: ["name", "employees", "country", "industry"],
      properties: {
        name: { type: "string", minLength: 1 },
        employees: { type: "integer", minimum: 0 },
        country: { type: "string", minLength: 2, maxLength: 2 },
        industry: { type: "string", minLength: 1 },
      },
    },
    plan: { type: "string", enum: ["free", "trial", "starter", "growth", "enterprise"] },
  },
} as const;

const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });

app.setErrorHandler((error: FastifyError, _request, reply) => {
  if (error.validation) {
    return reply.code(400).send({ code: "ERR_INPUT_INVALID", message: error.message });
  }
  return reply.code(error.statusCode ?? 500).send({ code: "ERR_INTERNAL", message: error.message });
});

app.get("/ping", () => ({ status: "ok" }));

const levels: Array<[string, (lead: Lead) => Derived]> = [
  ["light", light],
  ["medium", medium],
  ["heavy", heavy],
];
for (const [level, derive] of levels) {
  app.post<{ Body: Lead }>(`/leads/${level}`, { schema: { body: leadSchema } }, (request, reply) => {
    const lead = request.body;
    const body = { id: randomUUID(), level, lead, derived: derive(lead) };
    insert.run(body.id, JSON.stringify(body));
    return reply.code(201).send(body);
  });
}

app.get<{ Params: { id: string } }>("/leads/:id", (request, reply) => {
  const row = select.get(request.params.id) as { body: string } | undefined;
  if (!row) return reply.code(404).send({ code: "NOT_FOUND" });
  return JSON.parse(row.body);
});

await app.listen({ port, host: "127.0.0.1" });
