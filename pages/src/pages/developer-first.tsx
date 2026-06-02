import FeaturePage from "@site/src/components/FeaturePage";

export default function DeveloperFirst() {
  return (
    <FeaturePage
      slug="/developer-first"
      emoji="🛠"
      title="Developer first"
      tagline="Errors caught early, surfaced clearly, and traced to the line that needs fixing."
      intro="Telo treats developer experience as a correctness problem. Mistakes show up as actionable diagnostics in your editor - not as opaque stack traces at runtime - and the analyzer that powers them runs the same checks the kernel does before it boots."
      points={[
        {
          icon: "🔍",
          title: "Static analysis",
          body: "Reference validation, schema checks, and CEL type-checking run without executing the kernel, so broken wiring and type mismatches are caught at edit time.",
        },
        {
          icon: "💡",
          title: "IDE diagnostics",
          body: "The VS Code extension surfaces the analyzer's findings inline as you type, pointing at the exact place in the manifest that needs attention.",
        },
        {
          icon: "🚦",
          title: "Errors never swallowed",
          body: "Failures are surfaced, not hidden. Messages are written to guide you to a concrete fix rather than leave you guessing at the cause.",
        },
        {
          icon: "🪶",
          title: "No boilerplate",
          body: "Manifests are minimal - they carry your business logic and nothing else. There is no scaffolding, wiring, or framework ceremony to write and maintain around it.",
        },
        {
          icon: "🧩",
          title: "Composable micro-kernel",
          body: "The kernel knows nothing about HTTP or SQL. Everything is a module you import, scope, and compose - small, testable units instead of a monolith.",
        },
        {
          icon: "🌐",
          title: "Polyglot controllers",
          body: "Modules can be written in the language that fits the job. Node.js is fully supported today, Rust is partial, and Go is on the roadmap - so you pick the runtime, not the other way around.",
        },
        {
          icon: "👀",
          title: "Watch mode",
          body: "Run a manifest locally in watch mode and the kernel reloads on change, so the feedback loop between editing YAML and seeing it run is near-instant.",
        },
        {
          icon: "🔀",
          title: "Git-native workflow",
          body: "Manifests are plain text, so your whole backend lives in Git like any code: branch a feature, open a PR, review the diff, roll back a bad change, or bisect to find a regression. No proprietary versioning layer.",
        },
        {
          icon: "📖",
          title: "The manifest is the docs",
          body: "Because the manifest declares intent explicitly, it doubles as living documentation. There's no separate spec to write or keep in sync - what you read is what runs.",
        },
        {
          icon: "✅",
          title: "Validation at the edge",
          body: "Inputs are checked against JSON Schema before any handler runs, so malformed requests are rejected at the boundary with a clear error rather than blowing up deep in your logic.",
        },
        {
          icon: "🔐",
          title: "Variables & secrets, declared",
          body: "Configuration variables and secrets are declared as a typed contract and injected from the host environment - never hardcoded in the manifest, with secrets kept out of logs alongside ordinary config.",
        },
        {
          icon: "🔁",
          title: "Retries & backoff",
          body: "Declare retry policies with backoff right next to the step they protect, instead of scattering ad-hoc retry loops through handler code.",
        },
        {
          icon: "🔌",
          title: "Graceful shutdown",
          body: "On shutdown the kernel drains in-flight work and tears down services in order, so a deploy or restart never severs a request mid-flight or leaks a connection.",
        },
        {
          icon: "📊",
          title: "Built-in observability",
          planned: true,
          body: "Structured logging, metrics, and tracing as first-class primitives you compose into a manifest - insight into what's running without bolting on a separate stack.",
        },
        {
          icon: "🛑",
          title: "Request cancellation",
          planned: true,
          body: "A cancellation signal propagates through every downstream step, so abandoned requests stop their database, HTTP, and AI work instead of burning resources after the caller has gone.",
        },
      ]}
    />
  );
}
