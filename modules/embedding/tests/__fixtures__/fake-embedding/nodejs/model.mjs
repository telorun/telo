// Deterministic fake embedding backend for offline tests. Produces a stable
// vector from the text + intent so query and passage embeddings differ (which
// is what an asymmetric model does), without any network call.

function deterministicVector(text, intent, dimensions) {
  const seed = intent === "query" ? 1 : 2;
  const vec = new Array(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dimensions] += text.charCodeAt(i) * seed;
  }
  return vec;
}

export function register() {}

export async function create(resource) {
  const dimensions = resource.dimensions ?? 8;
  return {
    async embed(request) {
      const embeddings = request.texts.map((t) =>
        deterministicVector(t, request.intent, dimensions),
      );
      return {
        embeddings,
        dimensions,
        usage: { promptTokens: request.texts.length, totalTokens: request.texts.length },
      };
    },
    async provide() {
      return this;
    },
    snapshot() {
      return {};
    },
  };
}
