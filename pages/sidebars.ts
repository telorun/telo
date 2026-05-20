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
      items: [{ type: "doc", id: "guides/style-guide", label: "Style Guide" }],
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
        {
          type: "doc",
          id: "kernel/docs/application-env-variables",
          label: "Application Environment Variables",
        },
        { type: "doc", id: "kernel/docs/module-grants", label: "Module Grants" },
        { type: "doc", id: "kernel/docs/evaluation-context", label: "Evaluation Context" },
        { type: "doc", id: "kernel/docs/signals", label: "Signals" },
        { type: "doc", id: "kernel/docs/data-types", label: "Data Types" },
        {
          type: "doc",
          id: "kernel/docs/telemetry-and-observability",
          label: "Telemetry & Observability",
        },
      ],
    },
    {
      type: "category",
      label: "Standard Library",
      items: [
        { type: "doc", id: "modules/README", label: "Overview" },
        {
          type: "category",
          label: "AI",
          items: [
            { type: "doc", id: "modules/ai/README", label: "Overview" },
            { type: "doc", id: "modules/ai/docs/ai-model", label: "Ai.Model" },
            { type: "doc", id: "modules/ai/docs/ai-text", label: "Ai.Text" },
            { type: "doc", id: "modules/ai/docs/ai-text-stream", label: "Ai.TextStream" },
            {
              type: "category",
              label: "Providers",
              items: [
                {
                  type: "doc",
                  id: "modules/ai-openai/docs/ai-openai-model",
                  label: "Ai.OpenaiModel",
                },
              ],
            },
          ],
        },
        { type: "doc", id: "modules/assert/docs/manifest", label: "Assert" },
        { type: "doc", id: "modules/benchmark/README", label: "Benchmark" },
        { type: "doc", id: "modules/config/README", label: "Config" },
        { type: "doc", id: "modules/console/README", label: "Console" },
        { type: "doc", id: "modules/http-client/README", label: "HTTP Client" },
        {
          type: "category",
          label: "AWS Lambda",
          items: [
            { type: "doc", id: "modules/lambda/README", label: "Overview" },
            { type: "doc", id: "modules/lambda/docs/http-api", label: "Lambda.HttpApi" },
            { type: "doc", id: "modules/lambda/docs/sqs", label: "Lambda.Sqs" },
            { type: "doc", id: "modules/lambda/docs/direct", label: "Lambda.Direct" },
            { type: "doc", id: "modules/lambda/docs/deploying", label: "Deploying" },
            { type: "doc", id: "modules/lambda/docs/cold-starts", label: "Cold Starts" },
          ],
        },
        {
          type: "category",
          label: "HTTP Server",
          items: [
            { type: "doc", id: "modules/http-server/README", label: "Overview" },
            {
              type: "doc",
              id: "modules/http-server/docs/returns-and-catches",
              label: "returns & catches",
            },
          ],
        },
        { type: "doc", id: "modules/javascript/README", label: "JavaScript" },
        {
          type: "category",
          label: "MCP Server",
          items: [
            { type: "doc", id: "modules/mcp-server/README", label: "Overview" },
            { type: "doc", id: "modules/mcp-server/docs/stdio-server", label: "Mcp.StdioServer" },
            { type: "doc", id: "modules/mcp-server/docs/http-endpoint", label: "Mcp.HttpEndpoint" },
            { type: "doc", id: "modules/mcp-server/docs/tools", label: "Mcp.Tools" },
          ],
        },
        { type: "doc", id: "modules/record-stream/README", label: "Record Stream" },
        {
          type: "category",
          label: "Run",
          items: [
            {
              type: "doc",
              id: "modules/run/docs/structured-errors",
              label: "Structured Errors",
            },
          ],
        },
        {
          type: "category",
          label: "S3",
          items: [
            { type: "doc", id: "modules/s3/docs/bucket", label: "S3.Bucket" },
            { type: "doc", id: "modules/s3/docs/put", label: "S3.Put" },
            { type: "doc", id: "modules/s3/docs/get", label: "S3.Get" },
            { type: "doc", id: "modules/s3/docs/list", label: "S3.List" },
          ],
        },
        {
          type: "category",
          label: "SQL",
          items: [
            { type: "doc", id: "modules/sql/README", label: "Overview" },
            { type: "doc", id: "modules/sql/select", label: "Sql.Select" },
          ],
        },
        { type: "doc", id: "modules/sql-repository/README", label: "SQL Repository" },
        {
          type: "category",
          label: "Starlark",
          items: [
            { type: "doc", id: "modules/starlark/README", label: "Overview" },
            {
              type: "doc",
              id: "modules/starlark/docs/runtime-rust",
              label: "Rust runtime",
            },
          ],
        },
        { type: "doc", id: "modules/test/docs/suite", label: "Test.Suite" },
        { type: "doc", id: "modules/type/README", label: "Type" },
        { type: "doc", id: "modules/workflow/README", label: "Workflow" },
        { type: "doc", id: "modules/workflow-temporal/README", label: "Workflow (Temporal)" },
        {
          type: "category",
          label: "YAML",
          items: [
            { type: "doc", id: "modules/yaml/README", label: "Overview" },
            { type: "doc", id: "modules/yaml/docs/parse", label: "Yaml.Parse" },
          ],
        },
      ],
    },
    {
      type: "category",
      label: "SDK & Testing",
      items: [
        { type: "doc", id: "sdk/README", label: "SDK" },
        { type: "doc", id: "sdk/nodejs/README", label: "Node.js SDK" },
        {
          type: "doc",
          id: "templating/nodejs/docs/templating-engines",
          label: "Templating Engines",
        },
        { type: "doc", id: "tests/README", label: "Testing" },
      ],
    },
  ],
};

export default sidebars;
