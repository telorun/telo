import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Learn",
      collapsed: false,
      items: [
        { type: "doc", id: "docs/guides/getting-started", label: "Getting Started" },
        { type: "doc", id: "docs/guides/first-http-api", label: "Your first HTTP API" },
        { type: "doc", id: "docs/guides/how-telo-works", label: "How Telo works" },
        { type: "doc", id: "docs/guides/refs-and-cel", label: "!ref and !cel" },
        { type: "doc", id: "docs/guides/static-analysis", label: "Catching errors early" },
        { type: "doc", id: "docs/guides/composing-behaviour", label: "Composing behaviour" },
        { type: "doc", id: "docs/guides/configuration", label: "Configuring an application" },
        { type: "doc", id: "docs/guides/reusing-manifests", label: "Reusing manifests" },
        { type: "doc", id: "cli/README", label: "Installation & CLI" },
        { type: "doc", id: "docs/guides/coming-from", label: "Coming from somewhere else" },
        { type: "doc", id: "docs/guides/style-guide", label: "Style Guide" },
        { type: "doc", id: "docs/guides/glossary", label: "Glossary" },
      ],
    },
    {
      type: "category",
      label: "Build",
      collapsed: false,
      items: [
        { type: "doc", id: "docs/build/overview", label: "Overview" },
        { type: "doc", id: "docs/build/editor", label: "Telo Editor" },
        { type: "doc", id: "ide/vscode/README", label: "VS Code extension" },
        { type: "doc", id: "docs/coding-agents", label: "Working with coding agents" },
        { type: "doc", id: "docs/build/testing", label: "Testing your manifests" },
        { type: "doc", id: "docs/guides/logging", label: "Logging" },
      ],
    },
    {
      type: "category",
      label: "Deploy",
      collapsed: false,
      items: [
        { type: "doc", id: "docs/deploy/overview", label: "Overview" },
        { type: "doc", id: "docs/deploy/docker", label: "Docker image" },
        { type: "doc", id: "docs/deploy/lambda", label: "AWS Lambda" },
        { type: "doc", id: "docs/deploy/production", label: "Running in production" },
        { type: "doc", id: "docs/deploy/security", label: "Security & supply chain" },
      ],
    },
    {
      type: "category",
      label: "Extend",
      collapsed: false,
      items: [
        { type: "doc", id: "sdk/README", label: "Overview" },
        { type: "doc", id: "docs/extend/authoring-a-module", label: "Authoring a Module" },
        { type: "doc", id: "docs/extend/templated-definitions", label: "Templated Definitions" },
        { type: "doc", id: "docs/extend/kind-inheritance", label: "Kind Inheritance" },
        { type: "doc", id: "docs/extend/execution-zones", label: "Execution Zones" },
        {
          type: "category",
          label: "Node.js",
          items: [
            { type: "doc", id: "sdk/nodejs/README", label: "Overview" },
            {
              type: "doc",
              id: "templating/nodejs/docs/templating-engines",
              label: "Templating Engines",
            },
          ],
        },
        {
          type: "category",
          label: "Rust",
          items: [{ type: "doc", id: "sdk/rust/README", label: "Overview" }],
        },
      ],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: [
        { type: "doc", id: "docs/reference/standard-library", label: "Standard library" },
        { type: "doc", id: "docs/cel-reference", label: "CEL Functions" },
        { type: "doc", id: "docs/reference/diagnostics", label: "Diagnostics reference" },
        {
          type: "category",
          label: "Kernel",
          items: [
            { type: "doc", id: "kernel/README", label: "Overview" },
            {
              type: "category",
              label: "Concepts",
              items: [
                {
                  type: "doc",
                  id: "kernel/docs/resource-definition",
                  label: "Resource Definition",
                },
                { type: "doc", id: "kernel/docs/resource-lifecycle", label: "Resource Lifecycle" },
                {
                  type: "doc",
                  id: "kernel/docs/resource-references",
                  label: "Resource References",
                },
                { type: "doc", id: "kernel/docs/inheritance", label: "Inheritance" },
                { type: "doc", id: "kernel/docs/evaluation-context", label: "Evaluation Context" },
                { type: "doc", id: "kernel/docs/data-types", label: "Data Types" },
                { type: "doc", id: "kernel/docs/observed-state", label: "Observed State" },
                {
                  type: "doc",
                  id: "kernel/docs/invoke-cancellation",
                  label: "Invoke Cancellation",
                },
              ],
            },
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
            {
              type: "category",
              label: "Modules & Imports",
              items: [
                { type: "doc", id: "kernel/docs/modules", label: "Module System" },
                {
                  type: "doc",
                  id: "kernel/docs/application-env-variables",
                  label: "Application Environment Variables",
                },
                {
                  type: "doc",
                  id: "kernel/docs/application-ports",
                  label: "Application Ports",
                },
              ],
            },
            {
              type: "category",
              label: "Runtime & Ops",
              items: [
                { type: "doc", id: "kernel/docs/controllers", label: "Controllers" },
              ],
            },
            {
              type: "category",
              label: "Specifications",
              items: [
                { type: "doc", id: "kernel/specs/invocation-contract", label: "Invocation Contract" },
                { type: "doc", id: "kernel/specs/logging", label: "Logging" },
                { type: "doc", id: "kernel/specs/module-artifact", label: "Module Artifact" },
              ],
            },
          ],
        },
        {
          type: "link",
          label: "Modules (hub.telo.run)",
          href: "https://hub.telo.run",
        },
      ],
    },
    { type: "doc", id: "examples/INDEX", label: "Examples" },
  ],
};

export default sidebars;
