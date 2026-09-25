import { InvokeError, type ResourceManifest } from "@telorun/sdk";
import { Readability } from "@mozilla/readability";
import { fromDomChildren, toDomDocument } from "./dom-tree.js";
import type { Parsed } from "./html-node.js";

interface MainContentResource extends ResourceManifest {
  charThreshold?: number;
  nbTopCandidates?: number;
  keepClasses?: boolean;
  classesToPreserve?: string[];
  linkDensityModifier?: number;
  videoHosts?: string[];
  jsonLd?: boolean;
}

interface MainContentOutputs {
  content: Parsed;
  title?: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  lang?: string;
  dir?: string;
  publishedTime?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A host or any of its subdomains, as the URL regex the detector expects. */
function videoHostRegex(hosts: readonly string[]): RegExp {
  const alternatives = hosts.map((host) => escapeRegExp(host.toLowerCase())).join("|");
  return new RegExp(`\\/\\/([a-z0-9-]+\\.)*(${alternatives})(:\\d+)?(\\/|$)`, "i");
}

export async function create(resource: MainContentResource) {
  const options = {
    ...(resource.charThreshold !== undefined ? { charThreshold: resource.charThreshold } : {}),
    ...(resource.nbTopCandidates !== undefined ? { nbTopCandidates: resource.nbTopCandidates } : {}),
    ...(resource.keepClasses !== undefined ? { keepClasses: resource.keepClasses } : {}),
    ...(resource.classesToPreserve ? { classesToPreserve: resource.classesToPreserve } : {}),
    ...(resource.linkDensityModifier !== undefined
      ? { linkDensityModifier: resource.linkDensityModifier }
      : {}),
    ...(resource.videoHosts ? { allowedVideoRegex: videoHostRegex(resource.videoHosts) } : {}),
    disableJSONLD: resource.jsonLd === false,
  };

  return {
    async invoke({ document }: { document: Parsed }): Promise<MainContentOutputs> {
      const dom = toDomDocument(document.nodes);
      // The detector resolves relative links and media against these.
      for (const key of ["baseURI", "documentURI"]) {
        Object.defineProperty(dom, key, { value: document.baseUrl, configurable: true });
      }
      const article = new Readability<any>(dom as unknown as Document, {
        ...options,
        serializer: (element) => element,
      }).parse();
      if (!article || !article.content) {
        throw new InvokeError(
          "ERR_HTML_NO_MAIN_CONTENT",
          `${resource.kind} '${resource.metadata.name}': the document has no main content — ` +
            `no part of it scored as an article.`,
        );
      }
      const content: Parsed = { nodes: fromDomChildren(article.content) };
      if (document.baseUrl !== undefined) content.baseUrl = document.baseUrl;
      const out: MainContentOutputs = { content };
      for (const key of ["title", "byline", "excerpt", "siteName", "lang", "dir", "publishedTime"] as const) {
        const value = article[key];
        if (typeof value === "string" && value !== "") out[key] = value;
      }
      return out;
    },
  };
}
