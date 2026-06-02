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
          <div className="heroButtons">
            <Link className="button button--primary button--lg margin-right--md" to="/learn/getting-started">
              Get started
            </Link>
            <Link className="button button--outline button--primary button--lg" to="/examples">
              See examples
            </Link>
          </div>

          <div className="row heroCards margin-top--xl">
            <div className="col col--4">
              <Link className="card cardLink heroCard" to="/developer-first">
                <div className="card__header text--center">
                  <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                    🛠
                  </div>
                  <h3 className="margin-top--sm margin-bottom--none">Developer first</h3>
                </div>
                <div className="card__body">
                  Errors caught early, surfaced clearly, and traced to the line that needs fixing.
                </div>
              </Link>
            </div>
            <div className="col col--4">
              <Link className="card cardLink heroCard" to="/business-first">
                <div className="card__header text--center">
                  <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                    🤝
                  </div>
                  <h3 className="margin-top--sm margin-bottom--none">Business first</h3>
                </div>
                <div className="card__body">
                  One artifact for product and engineering - no spec-to-code translation layer.
                </div>
              </Link>
            </div>
            <div className="col col--4">
              <Link className="card cardLink heroCard" to="/ai-first">
                <div className="card__header text--center">
                  <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                    ✨
                  </div>
                  <h3 className="margin-top--sm margin-bottom--none">AI first</h3>
                </div>
                <div className="card__body">
                  Agents can generate, review, and transform entire backends without losing intent.
                </div>
              </Link>
            </div>
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

        <h2 className="text--center margin-top--xl margin-bottom--lg">Why Telo?</h2>
        <div className="row">
          <div className="col col--6 margin-bottom--md">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🌐
                </div>
                <h3 className="margin-top--sm">Open standards</h3>
              </div>
              <div className="card__body">
                Built on YAML, JSON Schema, and CEL - no proprietary DSL.
              </div>
            </div>
          </div>
          <div className="col col--6 margin-bottom--md">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🔍
                </div>
                <h3 className="margin-top--sm">Static analysis</h3>
              </div>
              <div className="card__body">
                CEL type checking, reference validation, and IDE diagnostics catch errors before
                runtime.
              </div>
            </div>
          </div>
          <div className="col col--6">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🧩
                </div>
                <h3 className="margin-top--sm">Micro-kernel architecture</h3>
              </div>
              <div className="card__body">
                The kernel itself knows nothing about HTTP or SQL. Everything is a module you
                import, scope, and compose.
              </div>
            </div>
          </div>
          <div className="col col--6">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🌍
                </div>
                <h3 className="margin-top--sm">Language-agnostic</h3>
              </div>
              <div className="card__body">
                Node.js today; the YAML runtime contract is designed to be re-implemented in Rust
                or Go without changing your manifests.
              </div>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}
