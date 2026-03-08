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
        { type: "doc", id: "kernel/resource-lifecycle", label: "Resource Lifecycle" },
        { type: "doc", id: "kernel/controllers", label: "Controllers" },
        { type: "doc", id: "kernel/modules", label: "Module System" },
        { type: "doc", id: "kernel/module-grants", label: "Module Grants" },
        { type: "doc", id: "kernel/evaluation-context", label: "Evaluation Context" },
        { type: "doc", id: "kernel/signals", label: "Signals" },
        { type: "doc", id: "kernel/data-types", label: "Data Types" },
        { type: "doc", id: "kernel/telemetry-and-observability", label: "Telemetry & Observability" },
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
