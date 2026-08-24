import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import CodeBlock from "@theme/CodeBlock";
import Layout from "@theme/Layout";
import TabItem from "@theme/TabItem";
import Tabs from "@theme/Tabs";

type SampleFile = { name: string; body: string };
type SampleCase = {
  id: string;
  label: string;
  blurb: string;
  files: SampleFile[];
  output: string;
};
type LandingSample = { cases: SampleCase[] };

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  const sample = siteConfig.customFields?.landingSample as LandingSample;

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
          <p className="margin-top--md">
            or open <a href="https://studio.telo.run">Telo Studio</a> · browse modules on the{" "}
            <a href="https://hub.telo.run">hub</a>
          </p>

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
        <div className="alert alert--warning margin-bottom--xl" role="note">
          <strong>Telo is under heavy development.</strong> While pre-1.0, breaking changes ship in
          minor releases — pin your imports and expect to update manifests when you upgrade. 1.0
          lands when the Rust kernel reaches feature parity with the Node.js implementation.
        </div>

        <p className="text--center" style={{ fontSize: "1.25rem", maxWidth: 720, margin: "0 auto" }}>
          You declare what your app is made of — its services, its routes, its data, what runs when
          something comes in — and Telo wires it together and runs it. Control flow and the values
          passing between resources are declared too, and checked before anything starts.
        </p>

        <h2 className="text--center margin-top--xl margin-bottom--none">Whole applications</h2>
        <p className="text--center margin-bottom--lg">
          On the left, everything the application is. On the right, that application running.
        </p>
        <Tabs className="sampleTabs">
          {sample.cases.map((c) => (
            <TabItem key={c.id} value={c.id} label={c.label}>
              <p>{c.blurb}</p>
              <div className="row">
                <div className="col col--6 margin-bottom--md">
                  {c.files.map((f) => (
                    <CodeBlock key={f.name} language="yaml" title={f.name}>
                      {f.body}
                    </CodeBlock>
                  ))}
                </div>
                <div className="col col--6 margin-bottom--md">
                  <CodeBlock language="bash" title="Terminal">
                    {c.output}
                  </CodeBlock>
                </div>
              </div>
            </TabItem>
          ))}
        </Tabs>
        <p className="text--center margin-top--md margin-bottom--xl">
          <Link to="/learn/first-http-api">Build the first one step by step →</Link>
          {" · "}
          <Link to="/learn/static-analysis">What else is caught before it runs →</Link>
        </p>

        <h2 className="text--center margin-top--xl margin-bottom--lg">How it works</h2>
        <div className="row margin-bottom--xl">
          <div className="col col--4 margin-bottom--md">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  ✍️
                </div>
                <h3 className="margin-top--sm">1. Declare it</h3>
              </div>
              <div className="card__body">
                Lay out what your app is made of, piece by piece, in YAML — plus expressions and
                schemas for the values that flow between them.
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
                import, scope, and compose — including the ones you write yourself, in TypeScript
                or Rust.
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
