import Link from "@docusaurus/Link";
import ExampleCards from "@site/src/components/ExampleCards";
import FeaturePage from "@site/src/components/FeaturePage";
import type { ReactNode } from "react";

const FAQ: { question: string; answer: ReactNode }[] = [
  {
    question: "Who maintains Telo?",
    answer: (
      <>
        CodeNet Sp. z o.o. holds the copyright and develops Telo. It is developed in the open on{" "}
        <a href="https://github.com/telorun/telo">GitHub</a>.
      </>
    ),
  },
  {
    question: "What support is there?",
    answer: (
      <>
        Questions and bug reports go to{" "}
        <a href="https://github.com/telorun/telo/issues">GitHub issues</a>. For commercial
        licensing and enterprise inquiries, write to{" "}
        <a href="mailto:contact@codenet.pl">contact@codenet.pl</a>. The repository does not
        describe a paid support plan or service levels, so ask before you plan around one.
      </>
    ),
  },
  {
    question: "What does an upgrade cost?",
    answer: (
      <>
        Telo is pre-1.0, and breaking changes ship in minor releases. Pin the versions you import
        and expect to update your application files when you upgrade; the <code>telo migrate</code>{" "}
        command rewrites old spellings for you. See{" "}
        <Link to="/deploy/upgrades">Upgrades &amp; version skew</Link>.
      </>
    ),
  },
  {
    question: "Are we locked in?",
    answer: (
      <>
        Your application is plain YAML files in your own Git repository, and the modules and the
        code you write against them are MIT-licensed. If you leave, you keep all of that; what you
        would have to replace is the behaviour the Telo runtime provides, such as starting things in
        order, checking, retries and shutdown. See <Link to="/learn/licensing">Licensing</Link>.
      </>
    ),
  },
  {
    question: "Can we sell something built on Telo?",
    answer: (
      <>
        Yes. What needs a commercial licence is offering Telo itself to others as a managed
        service. See <Link to="/learn/licensing">Licensing</Link>.
      </>
    ),
  },
  {
    question: "Is there a hosted Telo?",
    answer: <>Not yet. Telo Cloud is planned; today you run Telo yourself.</>,
  },
];

export default function BusinessFirst() {
  return (
    <FeaturePage
      slug="/for-teams"
      emoji="🤝"
      title="For teams"
      tagline="One description of the app that product can read and review, and engineering builds."
      intro="Most applications live as a spec the business owns and code the engineers own, with a lossy translation in between. With Telo, developers write the application as a set of plain files that also serve as its specification. Non-engineers can read and review what the app does; they are not expected to author it."
      points={[
        {
          icon: "📐",
          title: "A single source of truth",
          body: "The files that run in production are the description of what the app does. There is no separate diagram to drift out of sync with it.",
        },
        {
          icon: "⚡",
          title: "Fewer hand-offs",
          body: "Developers change the same files that Telo runs, so there is no separate spec-to-implementation step to maintain. Telo aims to shorten the path from a requirement to a running change; it does not remove the need for engineering.",
        },
        {
          icon: "🖥",
          title: "A visual view for review",
          body: "Telo Studio shows an application's structure as a diagram next to its files, so a reviewer can follow what connects to what. Edits made there change the same files; there is no drag-and-drop builder for end users.",
        },
        {
          icon: "💸",
          title: "Cheaper to change safely",
          body: "Telo checks the files before anything runs, so many mistakes show up at review time rather than in production. Less boilerplate means fewer places to update; how much you save depends on your team and your application.",
        },
        {
          icon: "🔭",
          title: "Reviewable by non-engineers",
          body: "The files are plain text. A product owner or analyst can read what an app does, which routes it serves and what it calls, and comment on a change. Writing them takes a developer.",
        },
        {
          icon: "🧾",
          title: "Auditable & reviewable",
          body: "Every change to an application is a diff to a readable file. Sign-off, compliance review, and a clear record of who changed what come straight from version control, not a separate change-management process.",
        },
        {
          icon: "♻️",
          title: "Work that survives a crash",
          body: "Long or critical processes, such as charging a card or waiting days for an approval, can be recorded step by step, so a restart continues where the work stopped instead of repeating it.",
        },
        {
          icon: "🔓",
          title: "You own the application",
          body: (
            <>
              Your application files are plain YAML in your own repository. The modules you build
              with and the code you write are MIT-licensed. The Telo runtime is{" "}
              <em>fair-code</em>: its source is public and free to use commercially, with one
              restriction, that you may not resell Telo itself as a hosted service. See{" "}
              <Link to="/learn/licensing">Licensing</Link>.
            </>
          ),
        },
        {
          icon: "🏠",
          title: "Self-hostable",
          body: "Run Telo on your own terms - on-premise or in your own cloud account - so your data and runtime stay where you need them, with no dependency on a hosted service.",
        },
        {
          icon: "📊",
          title: "Visibility into what's running",
          planned: true,
          body: "Built-in observability surfaces what the system is doing in terms the business can follow, so health and behaviour aren't locked away in engineering-only tooling.",
        },
        {
          icon: "🌩",
          title: "Telo Cloud",
          planned: true,
          body: "A managed runtime that runs your manifests for you - the convenience of a hosted platform when you want it, without giving up the option to self-host.",
        },
      ]}
      more={{ to: "/learn/vs-low-code", label: "How Telo compares to low-code platforms →" }}
    >
      <h2 className="text--center margin-top--xl">Where Telo is today</h2>
      <p>
        The runtime, the module system, the standard library and the checker work. Telo is pre-1.0
        on purpose: between versions your application files may need updating, and tooling rewrites
        old spellings for you. It is <strong>not yet recommended for production use</strong>. 1.0 is
        planned for when a second, Rust-based runtime can run everything the current Node.js one
        can.
      </p>

      <h2 className="text--center margin-top--xl">What your team needs</h2>
      <p>
        Telo is built for a team with developers. Plan for these skills: YAML, JSON Schema (a
        standard way to describe the shape of data), a small expression language called CEL, Git,
        and deploying a container. Telo is not aimed at non-programmers, and there is no
        click-to-build screen editor; screens are declared in YAML.
      </p>

      <h2 className="text--center margin-top--xl margin-bottom--none">What people build with Telo</h2>
      <p className="text--center margin-bottom--lg">
        Working examples from the repository, described in business terms.
      </p>
      <ExampleCards />

      <h2 className="text--center margin-top--xl">Questions teams ask</h2>
      {FAQ.map((item) => (
        <div key={item.question} className="margin-bottom--md">
          <h3>{item.question}</h3>
          <p>{item.answer}</p>
        </div>
      ))}
    </FeaturePage>
  );
}
