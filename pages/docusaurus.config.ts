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
            "kernel/resource-lifecycle.md",
            "kernel/controllers.md",
            "kernel/evaluation-context.md",
            "kernel/modules.md",
            "kernel/module-grants.md",
            "kernel/signals.md",
            "kernel/data-types.md",
            "kernel/telemetry-and-observability.md",
            "yaml-cel-templating/README.md",
            "modules/README.md",
            "modules/http-server/README.md",
            "modules/http-client/README.md",
            "modules/studio/README.md",
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

  themeConfig: {
    navbar: {
      title: "⚡ Telo",
      items: [
        { to: "/kernel/", label: "Kernel", position: "left" },
        { to: "/modules/", label: "Modules", position: "left" },
        { to: "/sdk/", label: "SDK", position: "left" },
        {
          href: "https://github.com/diglyai/telo",
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
