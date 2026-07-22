import FeaturePage from "@site/src/components/FeaturePage";

export default function AiFirst() {
  return (
    <FeaturePage
      slug="/for-ai"
      emoji="✨"
      title="For AI"
      tagline="Agents can generate, review, and transform entire backends without losing intent."
      intro="YAML is explicit and structured, so manifests are as readable to a model as they are to a person. Telo turns that legibility into a tight loop: an agent emits a manifest, the analyzer checks it statically, and the feedback points at the exact line to fix - no runtime guesswork."
      points={[
        {
          icon: "📝",
          title: "Declarative by construction",
          body: "Every route, schema, and workflow is data, not control flow. There is no hidden imperative state for an agent to reason around - the manifest is the whole truth.",
        },
        {
          icon: "🗺",
          title: "The manifest is the plan",
          body: "No separate spec or plan document to author before building. The manifest is the specification and the running app at once, so an agent describes intent directly in the artifact that executes.",
        },
        {
          icon: "🔁",
          title: "A real feedback loop",
          body: "Static analysis, CEL type-checking, and reference validation give agents machine-readable errors before anything runs, so a model can self-correct instead of shipping broken code.",
        },
        {
          icon: "🔬",
          title: "Local context, small diffs",
          body: "Resources are atomic and self-contained, so an agent edits one small, structured chunk without loading the whole codebase into its window. Less context per change means more reliable edits - and diffs a human can actually review.",
        },
        {
          icon: "💰",
          title: "Cheaper to build with AI",
          body: "Compact manifests and local changes mean an agent spends far fewer tokens per task, so the cost of building and maintaining a backend with AI stays low.",
        },
        {
          icon: "🤖",
          title: "Runs on smaller models",
          body: "Because the valid shape is small and schema-constrained, generating and editing manifests doesn't demand a frontier model - smaller, cheaper, even local models can do it reliably.",
        },
        {
          icon: "📦",
          title: "A discoverable hub",
          body: "The Telo hub is a federated index over every module and its schemas, exposed over MCP. An agent can search for a capability, read its contract, and wire it in without leaving the loop.",
        },
        {
          icon: "🎯",
          title: "Intent stays intact",
          body: "Because structure is preserved end to end, a transformation an agent applies maps back to a concrete, reviewable change - no spec-to-code drift to reconcile later.",
        },
      ]}
    />
  );
}
