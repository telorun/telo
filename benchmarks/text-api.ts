import Fastify from "fastify";

const app = Fastify({ logger: false });

app.get("/v1/ping", (_request, reply) => {
  reply.send({ ok: true });
});

app.post<{ Body: { text: string } }>(
  "/v1/analyze",
  {
    schema: {
      body: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    },
  },
  (request, reply) => {
    const { text } = request.body;
    const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const avgWordLength =
      words.length > 0
        ? Math.round(
            (words.reduce((s, w) => s + w.length, 0) / words.length) * 10,
          ) / 10
        : 0;
    reply.send({
      chars: text.length,
      words: words.length,
      sentences: sentences.length,
      avgWordLength,
      readingTimeSec: Math.round(words.length / 3.5),
    });
  },
);

app.post<{ Body: { text: string; op: string } }>(
  "/v1/transform",
  {
    schema: {
      body: {
        type: "object",
        required: ["text", "op"],
        properties: { text: { type: "string" }, op: { type: "string" } },
      },
    },
  },
  (request, reply) => {
    const { text, op } = request.body;
    if (op === "upper") { reply.send({ result: text.toUpperCase() }); return; }
    if (op === "lower") { reply.send({ result: text.toLowerCase() }); return; }
    if (op === "reverse") { reply.send({ result: text.split("").reverse().join("") }); return; }
    if (op === "slug") { reply.send({ result: text.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") }); return; }
    reply.code(400).send({ error: "Unknown op" });
  },
);

await app.listen({ port: 8845 });
