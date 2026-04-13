import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";

const config: Config = {
  title: "Telo",
  tagline: "The ultimate kernel for declarative backends.",
  url: "https://telo.run",
  baseUrl: process.env.BASE_URL ?? "/",
  trailingSlash: false,

  onBrokenLinks: "warn",

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  presets: [
    [
      "classic",
      {
        docs: {
          // Read directly from original markdown files — no copies
          path: "..",
          routeBasePath: "/",
          include: [
            "README.md",
            "guides/style-guide.md",
            "guides/templating.md",
            "cli/README.md",
            "kernel/README.md",
            "kernel/docs/resource-definition.md",
            "kernel/docs/capabilities.md",
            "kernel/docs/capabilities/invocable.md",
            "kernel/docs/topology.md",
            "kernel/docs/topologies/sequence.md",
            "kernel/docs/topologies/router.md",
            "kernel/docs/topologies/workflow.md",
            "kernel/docs/inheritance.md",
            "kernel/docs/resource-lifecycle.md",
            "kernel/docs/resource-references.md",
            "kernel/docs/controllers.md",
            "kernel/docs/modules.md",
            "kernel/docs/module-grants.md",
            "kernel/docs/evaluation-context.md",
            "kernel/docs/signals.md",
            "kernel/docs/data-types.md",
            "kernel/docs/telemetry-and-observability.md",
            "yaml-cel-templating/README.md",
            "modules/README.md",
            "modules/http-server/README.md",
            "modules/http-client/README.md",
            "modules/assert/docs/manifest.md",
            "modules/test/docs/suite.md",
            "sdk/README.md",
            "sdk/nodejs/README.md",
            "tests/README.md",
          ],
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: ["./plugins/llms-txt"],

  themeConfig: {
    navbar: {
      title: "⚡ Telo",
      items: [
        { to: "/kernel/", label: "Kernel", position: "left" },
        { to: "/modules/", label: "Modules", position: "left" },
        { to: "/sdk/", label: "SDK", position: "left" },
        {
          href: "https://github.com/telorun/telo",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      copyright: `Copyright © ${new Date().getFullYear()} DiglyAI. Released under the Fair-code License.`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
