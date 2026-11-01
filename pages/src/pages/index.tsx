import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import CodeBlock from "@theme/CodeBlock";
import Layout from "@theme/Layout";
import TabItem from "@theme/TabItem";
import Tabs from "@theme/Tabs";
import ExampleCards from "@site/src/components/ExampleCards";

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
  const logo = useBaseUrl("/telo.svg");

  return (
    <Layout description="Runtime for declarative applications — backend services and the data screens on top of them.">
      <Head>
        <title>Telo Runtime</title>
      </Head>
      <header className="hero heroBanner">
        <div className="container text--center">
          <img src={logo} alt="Telo" width={96} />
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
                  One description of the app that product can read and review, and engineering builds.
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
          <strong>Where Telo is today.</strong> The runtime, the module system, the standard
          library and the checker work. Telo is pre-1.0 on purpose: between versions your
          application files may need updating, and tooling rewrites old spellings for you. It is
          not yet recommended for production use. 1.0 is planned for when a second, Rust-based
          runtime can run everything the current Node.js one can. Telo is free to use, including
          commercially; see <Link to="/learn/licensing">Licensing</Link>.
        </div>

        <p className="text--center" style={{ fontSize: "1.25rem", maxWidth: 720, margin: "0 auto" }}>
          You declare what your app is made of — its services, its routes, its data, what runs when
          something comes in — and Telo wires it together and runs it. That covers backend services
          and the data screens on top of them (tables, forms, create and edit); screens are
          declared in YAML, and there is no drag-and-drop screen builder. Everything is checked
          before anything starts.
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
          {" · "}
          <Link to="/learn/vs-low-code">Compared to low-code platforms →</Link>
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

        <h2 className="text--center margin-top--xl margin-bottom--none">What people build with Telo</h2>
        <p className="text--center margin-bottom--lg">
          Four of the working examples in the repository, described in business terms.
        </p>
        <ExampleCards />

        <h2 className="text--center margin-top--xl margin-bottom--lg">Why it is built this way</h2>
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
                Applications are plain files in formats other tools already read (YAML, JSON Schema and the CEL expression language), so there is no proprietary language to learn or be locked into.
              </div>
            </div>
          </div>
          <div className="col col--6 margin-bottom--md">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🔍
                </div>
                <h3 className="margin-top--sm">Mistakes caught before launch</h3>
              </div>
              <div className="card__body">
                Wrong wiring and wrong value types are reported with the exact place to fix, before
                anything runs. Static analysis.
              </div>
            </div>
          </div>
          <div className="col col--6">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🧩
                </div>
                <h3 className="margin-top--sm">Built from small parts</h3>
              </div>
              <div className="card__body">
                Each capability — web serving, databases, AI — is a separate module you import and
                combine, including ones your team writes. Micro-kernel architecture.
              </div>
            </div>
          </div>
          <div className="col col--6">
            <div className="card">
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  🌍
                </div>
                <h3 className="margin-top--sm">Room for other languages</h3>
              </div>
              <div className="card__body">
                Today you extend Telo in TypeScript (Rust for some native modules); the runtime is
                designed so other languages can be added.
              </div>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}
