import Fastify from "fastify";
import { Database } from "bun:sqlite";

const db = new Database("./tmp/feedback.db");

db.run(`
  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL,
    source     TEXT,
    score      INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertStmt = db.prepare(
  "INSERT INTO feedback (text, source, score) VALUES (?, ?, ?)",
);
const selectAllStmt = db.prepare(
  "SELECT id, text, source, score, created_at FROM feedback ORDER BY created_at DESC",
);
const selectOneStmt = db.prepare(
  "SELECT id, text, source, score, created_at FROM feedback WHERE id = ?",
);

const app = Fastify({ logger: false });

app.post<{ Body: { text: string; source?: string } }>(
  "/v1/feedback",
  {
    schema: {
      body: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1 },
          source: { type: "string" },
        },
      },
    },
  },
  (request, reply) => {
    const { text, source } = request.body;
    insertStmt.run(text, source ?? null, text.length);
    reply.code(201).send({ ok: true, message: "Feedback received" });
  },
);

app.get("/v1/feedback", (_request, reply) => {
  reply.send(selectAllStmt.all());
});

app.get<{ Params: { id: string } }>("/v1/feedback/:id", (request, reply) => {
  const row = selectOneStmt.get(Number(request.params.id));
  if (!row) {
    reply.code(404).send({ ok: false, message: "Not found" });
    return;
  }
  reply.send(row);
});

await app.listen({ port: 8844 });
