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
          <p className="hero__subtitle">Define how your app works. Telo builds and runs it.</p>
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
              <Link className="card cardLink heroCard" to="/for-developers">
                <div className="card__header text--center">
                  <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                    🛠
                  </div>
                  <h3 className="margin-top--sm margin-bottom--none">For developers</h3>
                </div>
                <div className="card__body">
                  Mistakes get caught early and traced to the exact line to fix.
                </div>
              </Link>
            </div>
            <div className="col col--4">
              <Link className="card cardLink heroCard" to="/for-teams">
                <div className="card__header text--center">
                  <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                    🤝
                  </div>
                  <h3 className="margin-top--sm margin-bottom--none">For teams</h3>
                </div>
                <div className="card__body">
                  One shared file product and engineering both read - no translating ideas into code.
                </div>
              </Link>
            </div>
            <div className="col col--4">
              <Link className="card cardLink heroCard" to="/for-ai">
                <div className="card__header text--center">
                  <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                    ✨
                  </div>
                  <h3 className="margin-top--sm margin-bottom--none">For AI</h3>
                </div>
                <div className="card__body">
                  AI assistants can build and edit your whole system without losing the plan.
                </div>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="container margin-vert--xl">
        <p className="text--center" style={{ fontSize: "1.25rem", maxWidth: 720, margin: "0 auto" }}>
          Instead of writing code, you define what your app needs — its data, its rules, what happens
          when something comes in — and Telo turns that into a working system and runs it.
        </p>

        <h2 className="text--center margin-top--xl margin-bottom--lg">How it works</h2>
        <div className="row margin-bottom--xl">
          <div className="col col--4 margin-bottom--md">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  ✍️
                </div>
                <h3 className="margin-top--sm">1. Define it</h3>
              </div>
              <div className="card__body">
                Lay out what your app should do, piece by piece. No programming language to learn.
              </div>
            </div>
          </div>
          <div className="col col--4 margin-bottom--md">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  ✅
                </div>
                <h3 className="margin-top--sm">2. Telo checks it</h3>
              </div>
              <div className="card__body">
                Mistakes get caught and explained in plain language - before anything runs.
              </div>
            </div>
          </div>
          <div className="col col--4 margin-bottom--md">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🚀
                </div>
                <h3 className="margin-top--sm">3. Telo runs it</h3>
              </div>
              <div className="card__body">
                Your data, logic, and AI workflows go live - built straight from your description.
              </div>
            </div>
          </div>
        </div>

        <h2 className="text--center margin-top--xl margin-bottom--lg">Under the hood</h2>
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
