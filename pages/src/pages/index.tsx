import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";

export default function Home() {
  return (
    <Layout description="Runtime for declarative backends.">
      <Head>
        <title>Telo Runtime</title>
      </Head>
      <header className="hero heroBanner">
        <div className="container text--center">
          <img
            src="https://raw.githubusercontent.com/telorun/telo/main/assets/telo.png"
            alt="Telo"
            width={160}
          />
          <h1 className="hero__title">Telo</h1>
          <p className="hero__subtitle">Runtime for declarative backends.</p>
          <div>
            <Link className="button button--primary button--lg margin-right--md" to="/guides/getting-started">
              Get started
            </Link>
            <Link className="button button--outline button--primary button--lg" to="/kernel/">
              Read the kernel reference
            </Link>
          </div>
        </div>
      </header>

      <main className="container margin-vert--xl">
        <p>
          Telo is an execution engine (Micro-Kernel) that runs logic defined entirely in YAML
          manifests. Instead of writing imperative backend code, you define your routes, databases,
          schemas, and AI workflows as atomic, interconnected YAML documents. Telo takes those
          manifests and runs them.
        </p>

        <h2>Designed to be</h2>
        <ul>
          <li>
            <strong>AI first.</strong> YAML is explicit, structured, and easy for tools and agents
            to generate, review, and transform without losing intent.
          </li>
          <li>
            <strong>Developer first.</strong> Errors are surfaced clearly with actionable messages,
            CEL is statically type-checked, and IDE diagnostics catch problems before runtime.
          </li>
          <li>
            <strong>Business first.</strong> The runtime treats execution as a stable, predictable
            host so teams can focus on business outcomes instead of plumbing.
          </li>
        </ul>

        <h2>Why Telo?</h2>
        <ul>
          <li>
            <strong>Open standards.</strong> Built on YAML, JSON Schema, and CEL — no proprietary
            DSL.
          </li>
          <li>
            <strong>Static analysis.</strong> CEL type checking, reference validation, and IDE
            diagnostics catch errors before runtime.
          </li>
          <li>
            <strong>Micro-kernel architecture.</strong> The kernel itself knows nothing about HTTP
            or SQL. Everything is a module you import, scope, and compose.
          </li>
          <li>
            <strong>Language-agnostic.</strong> Node.js today; the YAML runtime contract is designed
            to be re-implemented in Rust or Go without changing your manifests.
          </li>
        </ul>

        <h2>Explore</h2>
        <ul>
          <li>
            <Link to="/cli/">CLI &amp; installation</Link>
          </li>
          <li>
            <Link to="/kernel/">Kernel reference</Link>
          </li>
          <li>
            <Link to="/standard-library/">Standard library modules</Link>
          </li>
          <li>
            <Link to="/sdk/">SDK for module authors</Link>
          </li>
        </ul>
      </main>
    </Layout>
  );
}
