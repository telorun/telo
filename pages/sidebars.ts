import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    { type: "doc", id: "README", label: "Introduction" },
    {
      type: "category",
      label: "Getting Started",
      items: [{ type: "doc", id: "cli/README", label: "Installation & CLI" }],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        { type: "doc", id: "guides/style-guide", label: "Style Guide" },
        { type: "doc", id: "guides/templating", label: "Template Modules" },
      ],
    },
    {
      type: "category",
      label: "Kernel Reference",
      items: [
        { type: "doc", id: "kernel/README", label: "Overview" },
        { type: "doc", id: "kernel/docs/resource-definition", label: "Resource Definition" },
        {
          type: "category",
          label: "Capabilities",
          items: [
            { type: "doc", id: "kernel/docs/capabilities", label: "Overview" },
            { type: "doc", id: "kernel/docs/capabilities/invocable", label: "Invocable" },
          ],
        },
        {
          type: "category",
          label: "Topology",
          items: [
            { type: "doc", id: "kernel/docs/topology", label: "Overview" },
            { type: "doc", id: "kernel/docs/topologies/sequence", label: "Sequence" },
            { type: "doc", id: "kernel/docs/topologies/router", label: "Router" },
            { type: "doc", id: "kernel/docs/topologies/workflow", label: "Workflow" },
          ],
        },
        { type: "doc", id: "kernel/docs/inheritance", label: "Inheritance" },
        { type: "doc", id: "kernel/docs/resource-lifecycle", label: "Resource Lifecycle" },
        { type: "doc", id: "kernel/docs/resource-references", label: "Resource References" },
        { type: "doc", id: "kernel/docs/controllers", label: "Controllers" },
        { type: "doc", id: "kernel/docs/modules", label: "Module System" },
        { type: "doc", id: "kernel/docs/module-grants", label: "Module Grants" },
        { type: "doc", id: "kernel/docs/evaluation-context", label: "Evaluation Context" },
        { type: "doc", id: "kernel/docs/signals", label: "Signals" },
        { type: "doc", id: "kernel/docs/data-types", label: "Data Types" },
        {
          type: "doc",
          id: "kernel/docs/telemetry-and-observability",
          label: "Telemetry & Observability",
        },
        { type: "doc", id: "yaml-cel-templating/README", label: "CEL-YAML Reference" },
      ],
    },
    {
      type: "category",
      label: "Standard Library",
      items: [
        { type: "doc", id: "modules/README", label: "Overview" },
        { type: "doc", id: "modules/http-server/README", label: "HTTP Server" },
        { type: "doc", id: "modules/http-client/README", label: "HTTP Client" },
        { type: "doc", id: "modules/assert/docs/manifest", label: "Assert.Manifest" },
        { type: "doc", id: "modules/test/docs/suite", label: "Test.Suite" },
      ],
    },
    {
      type: "category",
      label: "SDK & Testing",
      items: [
        { type: "doc", id: "sdk/README", label: "SDK" },
        { type: "doc", id: "sdk/nodejs/README", label: "Node.js SDK" },
        { type: "doc", id: "tests/README", label: "Testing" },
      ],
    },
  ],
};

export default sidebars;
