import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    { type: "doc", id: "README", label: "Introduction" },
    { type: "doc", id: "cli/README", label: "Telo CLI" },
    {
      type: "category",
      label: "Kernel",
      items: [
        { type: "doc", id: "kernel/README", label: "Specification" },
        { type: "doc", id: "kernel/CONTROLLERS", label: "Controllers" },
        { type: "doc", id: "kernel/MODULES", label: "Module Specification" },
        { type: "doc", id: "kernel/MODULE_GRANTS", label: "Module Grants Specification" },
        { type: "doc", id: "kernel/EVALUATION_CONTEXT", label: "Evaluation Context" },
        { type: "doc", id: "yaml-cel-templating/README", label: "CEL-YAML Specification" },
      ],
    },
    {
      type: "category",
      label: "Standard Library",
      items: [
        { type: "doc", id: "modules/README", label: "Overview" },
        { type: "doc", id: "modules/http-server/README", label: "HTTP Server" },
        { type: "doc", id: "modules/http-client/README", label: "HTTP Client" },
        { type: "doc", id: "modules/studio/README", label: "Studio" },
      ],
    },
    {
      type: "category",
      label: "Module Development",
      items: [
        { type: "doc", id: "sdk/README", label: "SDK" },
        { type: "doc", id: "sdk/nodejs/README", label: "Node.js SDK" },
        { type: "doc", id: "tests/README", label: "Testing" },
      ],
    },
    { type: "doc", id: "STYLEGUIDE", label: "Style Guide" },
  ],
};

export default sidebars;
