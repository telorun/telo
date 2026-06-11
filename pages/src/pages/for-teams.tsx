import FeaturePage from "@site/src/components/FeaturePage";

export default function BusinessFirst() {
  return (
    <FeaturePage
      slug="/for-teams"
      emoji="🤝"
      title="For teams"
      tagline="One artifact for product and engineering - no spec-to-code translation layer."
      intro="Most backends live as a spec the business owns and code the engineers own, with a lossy translation in between. Telo collapses that gap: the manifest is both the specification and the running system, and it stays visually editable the whole way."
      points={[
        {
          icon: "📐",
          title: "A single source of truth",
          body: "Product and engineering own and edit the same artifact, so the two work against one shared model instead of across a hand-off. What the business describes is what runs - no diagram that drifts out of sync with production.",
        },
        {
          icon: "⚡",
          title: "No translation layer",
          body: "There is no hand-off from spec to implementation to maintain. Changes go straight into the manifest that the kernel executes.",
        },
        {
          icon: "🖥",
          title: "Visual editing",
          body: "Backends are editable in the Telo editor as structured, visual documents - the declarative shape is never broken by constructs that can't be represented in a GUI.",
        },
        {
          icon: "🚀",
          title: "Faster time to market",
          body: "With no step to translate a spec into code, an idea moves from description to running backend in one artifact. Fewer hand-offs means features ship in the time it used to take just to write the spec.",
        },
        {
          icon: "💸",
          title: "Lower cost to change",
          body: "The expensive part of software is changing it later. A declarative manifest has no boilerplate to refactor and no spec-to-code drift to reconcile, so evolving a product stays cheap as it grows.",
        },
        {
          icon: "🔭",
          title: "Readable by everyone",
          body: "YAML manifests stay legible to non-engineers, making review and sign-off a shared activity rather than a code-review bottleneck.",
        },
        {
          icon: "🧾",
          title: "Auditable & reviewable",
          body: "Every change to a backend is a diff to a human-readable artifact. Sign-off, compliance review, and a clear record of who changed what come straight from version control, not a separate change-management process.",
        },
        {
          icon: "🔓",
          title: "You own the application",
          body: "Telo is fair-code and source-available: your manifests are open-standard YAML kept in your own repository, and you can read, modify, and run the kernel yourself. Your backend is an asset you own, not something trapped inside a vendor's console.",
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
    />
  );
}
