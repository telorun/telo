import FeaturePage from "@site/src/components/FeaturePage";

export default function DeveloperFirst() {
  return (
    <FeaturePage
      slug="/for-developers"
      emoji="🛠"
      title="For developers"
      tagline="Errors caught early, surfaced clearly, and traced to the line that needs fixing."
      intro="Telo checks what a typed framework leaves to discipline: that every error a handler throws is rendered, that a write meant for a transaction is inside one, that a retry won't resend a consumed stream, that shutdown cancels and cleans up. Manifests are plain text in Git, reviewed and rolled back like any code, and what you read is what runs."
      points={[
        {
          icon: "🔍",
          title: "Checked before it runs",
          body: "Every import, reference, schema and expression is resolved with no database, network or process — in the editor as you type, from the same engine as the release you run. The runtime refuses the same mistakes at start, with the same message.",
        },
        {
          icon: "🧯",
          title: "Every error has a handler",
          body: "Each error code a handler declares must be rendered by a catch around it — on the route, the router or the server. One nothing renders is refused before the app runs, instead of reaching a client as a 500.",
        },
        {
          icon: "🛑",
          title: "Request cancellation",
          body: "When a caller goes away — a client disconnecting, a timeout, a shutdown — cancellation flows down everything the call started, retry backoffs included. No cancellation token passed through every function.",
        },
        {
          icon: "🔌",
          title: "Graceful shutdown",
          body: "SIGINT and SIGTERM cancel in-flight work, refuse what has not started, close resources in reverse dependency order, flush logs last and exit with a defined code — the same in a packaged binary.",
        },
        {
          icon: "🔁",
          title: "Safe retries and timeouts",
          body: "Declare retry with backoff on any call. Cancellations and contract violations are never retried, a retry that would resend a consumed stream is refused, and a timeout cancels the call instead of leaving it running.",
        },
        {
          icon: "🔐",
          title: "See what an app needs",
          body: "--help lists every input with its variable and default, telo needs report lists what dependencies read, and telo env template writes the .env files. Every missing value is reported together before start, and secrets stay out of logs.",
        },
        {
          icon: "✅",
          title: "Validation on every call",
          body: "Inputs and outputs are checked against their declared schema on every call between resources, not only at the HTTP edge, so a bad value is stopped where it enters.",
        },
        {
          icon: "🗄",
          title: "Transactions, checked",
          body: "Every statement inside a transaction joins it at any depth, with nothing threaded through your code. A statement that needs a transaction is checked on every path the analyzer can see.",
        },
        {
          icon: "♻️",
          title: "Crash recovery",
          body: "Durable runs record each step and decision, so a restart resumes where the work stopped — and the ways durability silently breaks, like a non-deterministic call in a replayed region, are refused.",
        },
        {
          icon: "📊",
          title: "Observability built in",
          body: "Structured logs carry the resource and trace ids, every call is a span, and an incoming traceparent is continued. Tracing turns on by listing one sink; spans carry no payloads unless a field opts in.",
        },
        {
          icon: "🧩",
          title: "Write your own modules",
          body: "When the standard library lacks something, write a module beside your app with controllers in TypeScript or Rust. No build step, and its kinds are checked like the standard library's.",
        },
        {
          icon: "📦",
          title: "No install step, one executable",
          body: "telo run fetches each import on first use, verified against its pin — in watch mode too. telo package turns an app into one file that runs with no telo and no network.",
        },
      ]}
      more={{ to: "/learn/what-you-get", label: "See everything you get for free →" }}
    />
  );
}
