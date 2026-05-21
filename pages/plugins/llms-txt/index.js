const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

/**
 * Docusaurus plugin that generates llms.txt, llms-full.txt, and per-page
 * markdown files from the docs sidebar. Sections in llms.txt mirror the
 * top-level sidebar categories; nested categories are flattened under their
 * top-level parent (the llms.txt spec only allows one level of H2 sections
 * with a flat bullet list beneath each).
 *
 * Files are written to the site's `static/` directory so they are served
 * by both the dev server and the production build. (`static/` is copied
 * verbatim into the build output at `docusaurus build` time.)
 */
module.exports = function llmsTxtPlugin(context, options = {}) {
  const inputSections = Array.isArray(options.sections)
    ? options.sections
    : Array.isArray(options.sidebar)
      ? [{ sidebar: options.sidebar, docsPath: undefined, urlBasePath: "" }]
      : [];

  // Track files we generate so each rebuild can clean its own leftovers
  // (stale per-doc .md files from renamed/removed docs) without disturbing
  // hand-authored static assets like images.
  const trackerPath = path.resolve(context.siteDir, "static", ".llms-txt-generated.json");

  return {
    name: "llms-txt",

    async contentLoaded() {
      const staticDir = path.resolve(context.siteDir, "static");
      const siteConfig = context.siteConfig;
      const baseUrl = siteConfig.baseUrl ?? "/";
      const siteUrl = siteConfig.url + baseUrl;
      // Dev preview wants paths that resolve against whatever host the user
      // opened (pages.telo.localhost, etc.) — not the production URL baked
      // into siteConfig.
      const isDev = process.env.NODE_ENV !== "production";

      const fallbackDocsConfig = siteConfig.presets
        .flat()
        .map((p) => (Array.isArray(p) ? p[1] : p))
        .find((opts) => opts?.docs)?.docs;

      // Clean previously-generated files so renames don't leave orphans.
      cleanPreviousGeneration(staticDir, trackerPath);

      const generatedFiles = [];
      const resolvedSections = [];
      let totalEntries = 0;

      for (const input of inputSections) {
        const docsPath = path.resolve(
          context.siteDir,
          input.docsPath ?? fallbackDocsConfig?.path ?? "docs"
        );
        const urlBasePath = (input.urlBasePath ?? "").replace(/^\/|\/$/g, "");

        const sections = walkSidebar(input.sidebar ?? [], input.sectionTitle ?? null);

        for (const section of sections) {
          const entries = [];
          for (const doc of section.items) {
            const entry = resolveDoc(doc, {
              docsPath,
              outDir: staticDir,
              siteUrl,
              baseUrl,
              isDev,
              urlBasePath,
              generatedFiles,
            });
            if (entry) entries.push(entry);
          }
          if (entries.length) {
            resolvedSections.push({ title: section.title, entries });
            totalEntries += entries.length;
          }
        }
      }

      const llmsTxtPath = path.join(staticDir, "llms.txt");
      const llmsFullTxtPath = path.join(staticDir, "llms-full.txt");
      writeLlmsTxt(llmsTxtPath, siteConfig, resolvedSections);
      writeLlmsFullTxt(llmsFullTxtPath, siteConfig, resolvedSections);
      generatedFiles.push(llmsTxtPath, llmsFullTxtPath);

      fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
      fs.writeFileSync(
        trackerPath,
        JSON.stringify(
          generatedFiles.map((p) => path.relative(staticDir, p)),
          null,
          2
        ),
        "utf8"
      );

      console.log(
        `[llms-txt] Generated llms.txt (${totalEntries} entries across ${resolvedSections.length} sections), llms-full.txt, and ${generatedFiles.length - 2} per-doc markdown files in static/`
      );
    },
  };
};

function cleanPreviousGeneration(staticDir, trackerPath) {
  if (!fs.existsSync(trackerPath)) return;
  const staticDirReal = path.resolve(staticDir);
  const containedIn = (abs) => {
    const rel = path.relative(staticDirReal, abs);
    // Inside the static dir iff the relative path doesn't start with `..`
    // and isn't an absolute path on its own.
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  try {
    const prev = JSON.parse(fs.readFileSync(trackerPath, "utf8"));
    if (!Array.isArray(prev)) return;
    for (const rel of prev) {
      if (typeof rel !== "string") continue;
      const abs = path.resolve(staticDirReal, rel);
      // Reject anything that escapes the static directory — protects against
      // a corrupt or tampered tracker file containing `../...` entries.
      if (!containedIn(abs)) continue;
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      // Best-effort cleanup of empty parent dirs.
      let dir = path.dirname(abs);
      while (dir !== staticDirReal && containedIn(dir) && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: false });
          dir = path.dirname(dir);
        } catch {
          break;
        }
      }
    }
  } catch {
    // Tracker corrupt or unreadable — skip cleanup, next write replaces it.
  }
}

function walkSidebar(sidebar, forceSectionTitle = null) {
  const collectDocs = (items, bucket) => {
    for (const item of items) {
      if (typeof item === "string") {
        bucket.push({ id: item, label: null });
      } else if (item && typeof item === "object") {
        if (item.type === "doc" && typeof item.id === "string") {
          bucket.push({ id: item.id, label: item.label ?? null });
        } else if (item.type === "category" && Array.isArray(item.items)) {
          collectDocs(item.items, bucket);
        }
      }
    }
  };

  // If a section title is forced, flatten everything under it — useful when
  // an entire input (e.g. the modules sidebar) should land under a single
  // H2 like "Standard Library" rather than be split per sub-category.
  if (forceSectionTitle !== null) {
    const items = [];
    collectDocs(sidebar, items);
    return [{ title: forceSectionTitle, items }];
  }

  // Default: top-level docs land in an untitled lead section, and each
  // top-level category becomes its own H2.
  const sections = [{ title: null, items: [] }];
  for (const item of sidebar) {
    if (typeof item === "string") {
      sections[0].items.push({ id: item, label: null });
    } else if (item && typeof item === "object") {
      if (item.type === "doc" && typeof item.id === "string") {
        sections[0].items.push({ id: item.id, label: item.label ?? null });
      } else if (item.type === "category" && Array.isArray(item.items)) {
        const section = { title: item.label || "Section", items: [] };
        collectDocs(item.items, section.items);
        sections.push(section);
      }
    }
  }

  if (sections[0].items.length === 0) sections.shift();
  return sections;
}

function resolveDoc(
  { id, label },
  { docsPath, outDir, siteUrl, baseUrl = "/", isDev = false, urlBasePath = "", generatedFiles }
) {
  const srcFile = path.join(docsPath, `${id}.md`);
  if (!fs.existsSync(srcFile)) return null;

  const raw = fs.readFileSync(srcFile, "utf8");
  const { data: frontmatter, content } = matter(raw);

  const rawTitle =
    label ||
    frontmatter.title ||
    frontmatter.sidebar_label ||
    content.match(/^#\s+(.*)/m)?.[1] ||
    path.basename(id);
  const title = cleanTitle(rawTitle);

  const slug = frontmatter.slug ?? syntheticSlugForId(id);
  let docPath;
  if (slug !== undefined) {
    docPath = slug.replace(/^\//, "");
  } else if (id === "README") {
    // Bare `README` is the root index of its docs plugin (no path prefix).
    docPath = "";
  } else {
    docPath = id.replace(/\/README$/, "");
  }

  const routePath = urlBasePath
    ? docPath
      ? `${urlBasePath}/${docPath}`
      : urlBasePath
    : docPath;

  const mdOutputPath = routePath
    ? path.join(outDir, routePath + ".md")
    : path.join(outDir, "index.md");
  fs.mkdirSync(path.dirname(mdOutputPath), { recursive: true });
  fs.writeFileSync(mdOutputPath, content.trim() + "\n", "utf8");
  generatedFiles?.push(mdOutputPath);

  // Link to the raw markdown companion (already generated alongside this
  // entry) so LLMs follow links straight into source — never into HTML.
  const url = isDev
    ? routePath
      ? `${baseUrl}${routePath}.md`
      : `${baseUrl}index.md`
    : routePath
      ? `${siteUrl}${routePath}.md`
      : `${siteUrl}index.md`;
  const description = (frontmatter.description || "").replace(/\n/g, " ").trim();

  return { title, url, description, content: content.trim() };
}

function writeLlmsTxt(filePath, siteConfig, sections) {
  const lines = [`# ${siteConfig.title}`, "", `> ${siteConfig.tagline}`, ""];

  for (const section of sections) {
    if (section.title) lines.push(`## ${section.title}`, "");
    for (const entry of section.entries) {
      const desc = entry.description ? `: ${entry.description}` : "";
      lines.push(`- [${entry.title}](${entry.url})${desc}`);
    }
    lines.push("");
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

function writeLlmsFullTxt(filePath, siteConfig, sections) {
  const lines = [`# ${siteConfig.title}`, "", `> ${siteConfig.tagline}`, ""];

  for (const section of sections) {
    if (section.title) lines.push(`## ${section.title}`, "");
    for (const entry of section.entries) {
      lines.push(`### ${entry.title}`, "");
      if (entry.description) lines.push(entry.description, "");
      lines.push(`Source: ${entry.url}`, "");
      lines.push(bumpHeadings(stripLeadingH1(entry.content), 2), "");
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

/**
 * Mirror of the `markdown.parseFrontMatter` hook in docusaurus.config.ts:
 * docs under `modules/` serve under `/standard-library/...` but the slug
 * is injected at build time, so the raw `.md` files don't carry it.
 * The llms-txt plugin reads the files directly, so it has to apply the
 * same mapping itself or it would emit `/modules/...` URLs that no
 * Docusaurus route ever serves.
 *
 * Returns `undefined` for ids that don't need a synthetic slug, so the
 * default id-based logic in `resolveDoc` still runs for non-module docs.
 */
function syntheticSlugForId(id) {
  if (!id.startsWith("modules/")) return undefined;
  let rel = id.slice("modules/".length);
  if (rel === "README") {
    rel = "";
  } else {
    rel = rel.replace(/\/README$/, "");
  }
  return rel ? `/standard-library/${rel}` : "/standard-library";
}

function cleanTitle(s) {
  const stripped = s.replace(/^[\s\p{Extended_Pictographic}]+/gu, "").trim();
  return stripped || s.trim();
}

function stripLeadingH1(content) {
  return content.replace(/^\s*#\s+.*\n+/, "");
}

function bumpHeadings(content, offset) {
  const lines = content.split(/\r?\n/);
  let fenceChar = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      if (fenceChar === null) fenceChar = char;
      else if (char === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const heading = line.match(/^(#+)(\s)(.*)$/);
    if (!heading) continue;
    const level = Math.min(heading[1].length + offset, 6);
    lines[i] = "#".repeat(level) + heading[2] + heading[3];
  }
  return lines.join("\n");
}
