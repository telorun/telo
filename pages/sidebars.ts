import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Learn",
      collapsed: false,
      items: [
        { type: "doc", id: "docs/guides/getting-started", label: "Getting Started" },
        { type: "doc", id: "cli/README", label: "Installation & CLI" },
        { type: "doc", id: "docs/guides/style-guide", label: "Style Guide" },
      ],
    },
    {
      type: "category",
      label: "Build",
      collapsed: false,
      items: [
        { type: "doc", id: "docs/build/overview", label: "Overview" },
        { type: "doc", id: "docs/build/editor", label: "Telo Editor" },
        { type: "doc", id: "docs/coding-agents", label: "Working with coding agents" },
        { type: "doc", id: "tests/README", label: "Testing your manifests" },
      ],
    },
    {
      type: "category",
      label: "Deploy",
      collapsed: false,
      items: [
        { type: "doc", id: "docs/deploy/overview", label: "Overview" },
        { type: "doc", id: "docs/deploy/docker", label: "Docker image" },
        { type: "doc", id: "modules/lambda/docs/deploying", label: "AWS Lambda" },
      ],
    },
    {
      type: "category",
      label: "Extend",
      collapsed: false,
      items: [
        { type: "doc", id: "sdk/README", label: "Overview" },
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
        { type: "doc", id: "docs/cel-reference", label: "CEL Functions" },
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
                { type: "doc", id: "kernel/docs/signals", label: "Signals" },
                {
                  type: "doc",
                  id: "kernel/docs/telemetry-and-observability",
                  label: "Telemetry & Observability",
                },
              ],
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
                { type: "doc", id: "modules/ai/docs/ai-tool-provider", label: "Ai.ToolProvider" },
                { type: "doc", id: "modules/ai/docs/ai-agent", label: "Ai.Agent" },
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
                {
                  type: "category",
                  label: "Tools (MCP)",
                  items: [
                    { type: "doc", id: "modules/ai-mcp/README", label: "Overview" },
                    {
                      type: "doc",
                      id: "modules/ai-mcp/docs/ai-mcp-tool-provider",
                      label: "AiMcp.ToolProvider",
                    },
                  ],
                },
                {
                  type: "category",
                  label: "Embeddings",
                  items: [
                    { type: "doc", id: "modules/embedding/README", label: "Overview" },
                    {
                      type: "doc",
                      id: "modules/embedding/docs/embedding-model",
                      label: "Embedding.Model",
                    },
                    {
                      type: "doc",
                      id: "modules/embedding/docs/embedding-query",
                      label: "Embedding.Query",
                    },
                    {
                      type: "doc",
                      id: "modules/embedding/docs/embedding-passage",
                      label: "Embedding.Passage",
                    },
                    {
                      type: "category",
                      label: "Providers",
                      items: [
                        {
                          type: "doc",
                          id: "modules/embedding-openai/docs/embedding-openai-model",
                          label: "EmbeddingOpenai.Model",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "category",
              label: "HTTP & APIs",
              items: [
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
                    {
                      type: "doc",
                      id: "modules/http-server/docs/static-files",
                      label: "static files & frontends",
                    },
                  ],
                },
                { type: "doc", id: "modules/http-client/README", label: "HTTP Client" },
                {
                  type: "category",
                  label: "MCP Server",
                  items: [
                    { type: "doc", id: "modules/mcp-server/README", label: "Overview" },
                    {
                      type: "doc",
                      id: "modules/mcp-server/docs/stdio-server",
                      label: "Mcp.StdioServer",
                    },
                    {
                      type: "doc",
                      id: "modules/mcp-server/docs/http-endpoint",
                      label: "Mcp.HttpEndpoint",
                    },
                    { type: "doc", id: "modules/mcp-server/docs/tools", label: "Mcp.Tools" },
                  ],
                },
                {
                  type: "category",
                  label: "MCP Client",
                  items: [
                    { type: "doc", id: "modules/mcp-client/README", label: "Overview" },
                    {
                      type: "doc",
                      id: "modules/mcp-client/docs/http-client",
                      label: "Mcp.HttpClient",
                    },
                    {
                      type: "doc",
                      id: "modules/mcp-client/docs/stdio-client",
                      label: "Mcp.StdioClient",
                    },
                    {
                      type: "doc",
                      id: "modules/mcp-client/docs/tools-call",
                      label: "Mcp.ToolsCall",
                    },
                    {
                      type: "doc",
                      id: "modules/mcp-client/docs/tools-list",
                      label: "Mcp.ToolsList",
                    },
                    {
                      type: "doc",
                      id: "modules/mcp-client/docs/session-providers",
                      label: "Session providers",
                    },
                  ],
                },
              ],
            },
            {
              type: "category",
              label: "Storage & Data",
              items: [
                {
                  type: "category",
                  label: "SQL",
                  items: [
                    { type: "doc", id: "modules/sql/README", label: "Overview" },
                    { type: "doc", id: "modules/sql/selection", label: "Sql.Selection" },
                    { type: "doc", id: "modules/sql-postgres/README", label: "SQL Postgres" },
                    { type: "doc", id: "modules/sql-sqlite/README", label: "SQL SQLite" },
                  ],
                },
                { type: "doc", id: "modules/sql-repository/README", label: "SQL Repository" },
                {
                  type: "category",
                  label: "Cache",
                  items: [
                    { type: "doc", id: "modules/cache/README", label: "Overview" },
                    { type: "doc", id: "modules/cache-memory/README", label: "Cache Memory" },
                    { type: "doc", id: "modules/cache-redis/README", label: "Cache Redis" },
                  ],
                },
                {
                  type: "category",
                  label: "Vector Store",
                  items: [
                    { type: "doc", id: "modules/vector-store/README", label: "Overview" },
                    {
                      type: "doc",
                      id: "modules/vector-store/docs/vector-store",
                      label: "VectorStore",
                    },
                    {
                      type: "doc",
                      id: "modules/vector-store-memory/README",
                      label: "Vector Store Memory",
                    },
                  ],
                },
                { type: "doc", id: "modules/rate-limit/README", label: "Rate Limit" },
                {
                  type: "category",
                  label: "S3",
                  items: [
                    { type: "doc", id: "modules/s3/README", label: "Overview" },
                    { type: "doc", id: "modules/s3/docs/bucket", label: "S3.Bucket" },
                    { type: "doc", id: "modules/s3/docs/put", label: "S3.Put" },
                    { type: "doc", id: "modules/s3/docs/get", label: "S3.Get" },
                    { type: "doc", id: "modules/s3/docs/list", label: "S3.List" },
                    { type: "doc", id: "modules/s3/docs/delete", label: "S3.Delete" },
                    {
                      type: "doc",
                      id: "modules/s3/docs/presigned-url",
                      label: "S3.PresignedUrl",
                    },
                  ],
                },
                {
                  type: "category",
                  label: "Image",
                  items: [
                    { type: "doc", id: "modules/image/README", label: "Overview" },
                    { type: "doc", id: "modules/image/docs/blank", label: "Image.Blank" },
                    { type: "doc", id: "modules/image/docs/overlay", label: "Image.Overlay" },
                  ],
                },
                {
                  type: "category",
                  label: "PDF",
                  items: [
                    { type: "doc", id: "modules/pdf/README", label: "Overview" },
                    { type: "doc", id: "modules/pdf/docs/rasterizer", label: "Pdf.Rasterizer" },
                    { type: "doc", id: "modules/pdf/docs/form-fields", label: "Pdf.FormFields" },
                  ],
                },
                { type: "doc", id: "modules/type/README", label: "Type" },
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
              label: "Workflow & Control Flow",
              items: [
                {
                  type: "category",
                  label: "Run",
                  items: [
                    { type: "doc", id: "modules/run/README", label: "Overview" },
                    {
                      type: "doc",
                      id: "modules/run/docs/value",
                      label: "Run.Value",
                    },
                    {
                      type: "doc",
                      id: "modules/run/docs/detach",
                      label: "Run.Detach",
                    },
                    {
                      type: "doc",
                      id: "modules/run/docs/loop",
                      label: "Run.Loop",
                    },
                    {
                      type: "doc",
                      id: "modules/run/docs/iteration",
                      label: "Run.Iteration",
                    },
                    {
                      type: "doc",
                      id: "modules/run/docs/projection",
                      label: "Run.Projection",
                    },
                    {
                      type: "doc",
                      id: "modules/run/docs/structured-errors",
                      label: "Structured Errors",
                    },
                  ],
                },
                {
                  type: "category",
                  label: "Timer",
                  items: [
                    { type: "doc", id: "modules/timer/README", label: "Overview" },
                    { type: "doc", id: "modules/timer/docs/delay", label: "Timer.Delay" },
                  ],
                },
                { type: "doc", id: "modules/workflow/README", label: "Workflow" },
                {
                  type: "doc",
                  id: "modules/workflow-temporal/README",
                  label: "Workflow (Temporal)",
                },
              ],
            },
            {
              type: "category",
              label: "Encoding & Streams",
              items: [
                { type: "doc", id: "modules/codec/README", label: "Codec (abstracts)" },
                { type: "doc", id: "modules/plain-text-codec/README", label: "Plain Text Codec" },
                { type: "doc", id: "modules/ndjson-codec/README", label: "NDJSON Codec" },
                { type: "doc", id: "modules/sse-codec/README", label: "SSE Codec" },
                { type: "doc", id: "modules/octet-codec/README", label: "Octet Codec" },
                { type: "doc", id: "modules/record-stream/README", label: "Record Stream" },
                {
                  type: "category",
                  label: "Stream",
                  items: [
                    { type: "doc", id: "modules/stream/README", label: "Overview" },
                    { type: "doc", id: "modules/stream/docs/of", label: "Stream.Of" },
                  ],
                },
                {
                  type: "category",
                  label: "Gzip Codec",
                  items: [
                    { type: "doc", id: "modules/gzip/README", label: "Overview" },
                    { type: "doc", id: "modules/gzip/docs/encoder", label: "Gzip.Encoder" },
                    { type: "doc", id: "modules/gzip/docs/decoder", label: "Gzip.Decoder" },
                  ],
                },
                {
                  type: "category",
                  label: "Tar",
                  items: [
                    { type: "doc", id: "modules/tar/README", label: "Overview" },
                    { type: "doc", id: "modules/tar/docs/pack", label: "Tar.Pack" },
                    { type: "doc", id: "modules/tar/docs/extract", label: "Tar.Extract" },
                  ],
                },
              ],
            },
            {
              type: "category",
              label: "Runtime Targets",
              items: [
                {
                  type: "category",
                  label: "AWS Lambda",
                  items: [
                    { type: "doc", id: "modules/lambda/README", label: "Overview" },
                    { type: "doc", id: "modules/lambda/docs/http-api", label: "Lambda.HttpApi" },
                    { type: "doc", id: "modules/lambda/docs/sqs", label: "Lambda.Sqs" },
                    { type: "doc", id: "modules/lambda/docs/direct", label: "Lambda.Direct" },
                    { type: "doc", id: "modules/lambda/docs/cold-starts", label: "Cold Starts" },
                  ],
                },
              ],
            },
            {
              type: "category",
              label: "Scripting",
              items: [
                { type: "doc", id: "modules/javascript/README", label: "JavaScript" },
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
              ],
            },
            {
              type: "category",
              label: "Configuration & Ops",
              items: [
                { type: "doc", id: "modules/config/README", label: "Config" },
                { type: "doc", id: "modules/console/README", label: "Console" },
                { type: "doc", id: "modules/benchmark/README", label: "Benchmark" },
              ],
            },
            {
              type: "category",
              label: "Testing",
              items: [
                {
                  type: "category",
                  label: "Assert",
                  items: [
                    { type: "doc", id: "modules/assert/README", label: "Overview" },
                    { type: "doc", id: "modules/assert/docs/manifest", label: "Assert.Manifest" },
                  ],
                },
                {
                  type: "category",
                  label: "Test",
                  items: [
                    { type: "doc", id: "modules/test/README", label: "Overview" },
                    { type: "doc", id: "modules/test/docs/suite", label: "Test.Suite" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: "doc", id: "examples/INDEX", label: "Examples" },
  ],
};

export default sidebars;
