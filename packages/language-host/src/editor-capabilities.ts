import type { ClientCapabilities, SemanticTokensLegend, ServerCapabilities } from "vscode-languageserver-protocol";

/** A feature's options as one engine advertises them; `true` reads as `{}`. */
export type FeatureOptions = Record<string, any>;

/**
 * An LSP feature the router presents to the editor on behalf of its engines:
 * where an engine advertises it, how the editor registers it dynamically, and
 * how several engines' options become the one set the editor sees.
 */
export interface EditorFeature {
  capability: keyof ServerCapabilities;
  /** The method a dynamic registration of the feature names. */
  registration: string;
  /** Whether the editor accepts a dynamic registration of it. */
  dynamic(client: ClientCapabilities): boolean;
  merge(options: FeatureOptions[]): FeatureOptions;
}

const union = (lists: Array<unknown[] | undefined>): string[] | undefined => {
  const present = lists.filter((l): l is string[] => Array.isArray(l));
  return present.length === 0 ? undefined : [...new Set(present.flat())];
};
const any = (options: FeatureOptions[], key: string) => options.some((o) => o[key] === true);

/** Options with nothing to merge but a resolve step. */
const resolvable = (options: FeatureOptions[]): FeatureOptions => (any(options, "resolveProvider") ? { resolveProvider: true } : {});

const textDocument = (key: string) => (client: ClientCapabilities) =>
  (client.textDocument as Record<string, { dynamicRegistration?: boolean } | undefined> | undefined)?.[key]
    ?.dynamicRegistration === true;

function feature(
  capability: keyof ServerCapabilities,
  method: string,
  clientKey: string,
  merge: EditorFeature["merge"] = resolvable,
): EditorFeature {
  return { capability, registration: `textDocument/${method}`, dynamic: textDocument(clientKey), merge };
}

/** The semantic-token legend of several engines: every token type and modifier
 *  any of them names, in first-seen order. */
export function unionLegend(legends: SemanticTokensLegend[]): SemanticTokensLegend {
  return {
    tokenTypes: [...new Set(legends.flatMap((l) => l.tokenTypes))],
    tokenModifiers: [...new Set(legends.flatMap((l) => l.tokenModifiers))],
  };
}

export const EDITOR_FEATURES: EditorFeature[] = [
  feature("completionProvider", "completion", "completion", (options) => {
    const triggerCharacters = union(options.map((o) => o.triggerCharacters));
    const allCommitCharacters = union(options.map((o) => o.allCommitCharacters));
    return {
      ...(triggerCharacters ? { triggerCharacters } : {}),
      ...(allCommitCharacters ? { allCommitCharacters } : {}),
      ...resolvable(options),
    };
  }),
  feature("hoverProvider", "hover", "hover"),
  feature("signatureHelpProvider", "signatureHelp", "signatureHelp", (options) => {
    const triggerCharacters = union(options.map((o) => o.triggerCharacters));
    const retriggerCharacters = union(options.map((o) => o.retriggerCharacters));
    return {
      ...(triggerCharacters ? { triggerCharacters } : {}),
      ...(retriggerCharacters ? { retriggerCharacters } : {}),
    };
  }),
  feature("declarationProvider", "declaration", "declaration"),
  feature("definitionProvider", "definition", "definition"),
  feature("typeDefinitionProvider", "typeDefinition", "typeDefinition"),
  feature("implementationProvider", "implementation", "implementation"),
  feature("referencesProvider", "references", "references"),
  feature("documentHighlightProvider", "documentHighlight", "documentHighlight"),
  feature("documentSymbolProvider", "documentSymbol", "documentSymbol"),
  feature("codeActionProvider", "codeAction", "codeAction", (options) => {
    // An engine naming no kinds may answer any kind, so the union then names none.
    const kinds = options.every((o) => Array.isArray(o.codeActionKinds))
      ? union(options.map((o) => o.codeActionKinds))
      : undefined;
    return { ...(kinds ? { codeActionKinds: kinds } : {}), ...resolvable(options) };
  }),
  feature("codeLensProvider", "codeLens", "codeLens"),
  feature("documentLinkProvider", "documentLink", "documentLink"),
  feature("documentFormattingProvider", "formatting", "formatting", () => ({})),
  feature("documentRangeFormattingProvider", "rangeFormatting", "rangeFormatting", () => ({})),
  feature("renameProvider", "rename", "rename", (options) => (any(options, "prepareProvider") ? { prepareProvider: true } : {})),
  feature("foldingRangeProvider", "foldingRange", "foldingRange", () => ({})),
  feature("selectionRangeProvider", "selectionRange", "selectionRange", () => ({})),
  feature("inlayHintProvider", "inlayHint", "inlayHint"),
  feature("semanticTokensProvider", "semanticTokens", "semanticTokens", (options) => ({
    legend: unionLegend(options.map((o) => o.legend as SemanticTokensLegend)),
    // Deltas are not offered: a delta cannot be remapped between legends
    // without the result it applies to.
    ...(options.some((o) => o.full) ? { full: true } : {}),
    ...(any(options, "range") ? { range: true } : {}),
  })),
  {
    capability: "executeCommandProvider",
    registration: "workspace/executeCommand",
    dynamic: (client) => client.workspace?.executeCommand?.dynamicRegistration === true,
    merge: (options) => ({ commands: union(options.map((o) => o.commands)) ?? [] }),
  },
];

/** The options an engine advertises for a feature, or `undefined`. */
export function featureOptions(capabilities: ServerCapabilities, feature: EditorFeature): FeatureOptions | undefined {
  const value = capabilities[feature.capability] as unknown;
  if (value === undefined || value === false || value === null) return undefined;
  return value === true ? {} : (value as FeatureOptions);
}

/** Which advertised capability a request needs, and whether an engine's
 *  options for it serve that request. */
interface RequestNeed {
  capability: keyof ServerCapabilities;
  serves(options: FeatureOptions, params: any): boolean;
}

const plain = (capability: keyof ServerCapabilities): RequestNeed => ({ capability, serves: () => true });
const resolving = (capability: keyof ServerCapabilities): RequestNeed => ({
  capability,
  serves: (o) => o.resolveProvider === true,
});

const REQUEST_NEEDS: Record<string, RequestNeed> = {
  "textDocument/completion": plain("completionProvider"),
  "completionItem/resolve": resolving("completionProvider"),
  "textDocument/hover": plain("hoverProvider"),
  "textDocument/signatureHelp": plain("signatureHelpProvider"),
  "textDocument/declaration": plain("declarationProvider"),
  "textDocument/definition": plain("definitionProvider"),
  "textDocument/typeDefinition": plain("typeDefinitionProvider"),
  "textDocument/implementation": plain("implementationProvider"),
  "textDocument/references": plain("referencesProvider"),
  "textDocument/documentHighlight": plain("documentHighlightProvider"),
  "textDocument/documentSymbol": plain("documentSymbolProvider"),
  "textDocument/codeAction": plain("codeActionProvider"),
  "codeAction/resolve": resolving("codeActionProvider"),
  "textDocument/codeLens": plain("codeLensProvider"),
  "codeLens/resolve": resolving("codeLensProvider"),
  "textDocument/documentLink": plain("documentLinkProvider"),
  "documentLink/resolve": resolving("documentLinkProvider"),
  "textDocument/formatting": plain("documentFormattingProvider"),
  "textDocument/rangeFormatting": plain("documentRangeFormattingProvider"),
  "textDocument/rename": plain("renameProvider"),
  "textDocument/prepareRename": { capability: "renameProvider", serves: (o) => o.prepareProvider === true },
  "textDocument/foldingRange": plain("foldingRangeProvider"),
  "textDocument/selectionRange": plain("selectionRangeProvider"),
  "textDocument/inlayHint": plain("inlayHintProvider"),
  "inlayHint/resolve": resolving("inlayHintProvider"),
  "textDocument/semanticTokens/full": { capability: "semanticTokensProvider", serves: (o) => !!o.full },
  "textDocument/semanticTokens/range": { capability: "semanticTokensProvider", serves: (o) => o.range === true },
  "workspace/executeCommand": {
    capability: "executeCommandProvider",
    serves: (o, params) => Array.isArray(o.commands) && o.commands.includes(params?.command),
  },
};

/** Whether engine `capabilities` serve `method` with `params`; `undefined`
 *  for a method no advertised capability governs. */
export function advertises(capabilities: ServerCapabilities, method: string, params: unknown): boolean | undefined {
  const need = REQUEST_NEEDS[method];
  if (!need) return undefined;
  const value = capabilities[need.capability] as unknown;
  if (value === undefined || value === false || value === null) return false;
  return need.serves(value === true ? {} : (value as FeatureOptions), params);
}

/** The requests whose answers carry items a later resolve request hands back. */
export const RESOLVES: Record<string, string> = {
  "completionItem/resolve": "textDocument/completion",
  "codeAction/resolve": "textDocument/codeAction",
  "codeLens/resolve": "textDocument/codeLens",
  "documentLink/resolve": "textDocument/documentLink",
  "inlayHint/resolve": "textDocument/inlayHint",
};

/** How one engine's token indices map into the legend the editor holds; `-1`
 *  for a type the editor's legend lacks (the token is dropped). */
export interface LegendRemap {
  types: number[];
  modifiers: number[];
}

export function legendRemap(engine: SemanticTokensLegend, editor: SemanticTokensLegend): LegendRemap {
  return {
    types: engine.tokenTypes.map((t) => editor.tokenTypes.indexOf(t)),
    modifiers: engine.tokenModifiers.map((m) => editor.tokenModifiers.indexOf(m)),
  };
}

export function isIdentityRemap(remap: LegendRemap): boolean {
  return remap.types.every((t, i) => t === i) && remap.modifiers.every((m, i) => m === i);
}

/** Relative semantic tokens re-expressed in the editor's legend: each token's
 *  type and modifier bits remapped, a token of an unknown type dropped (the
 *  positions after it re-encoded), an unknown modifier bit cleared. */
export function remapTokens(data: number[], remap: LegendRemap): number[] {
  const out: number[] = [];
  let line = 0;
  let character = 0;
  let lastLine = 0;
  let lastCharacter = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i]!;
    character = data[i] === 0 ? character + data[i + 1]! : data[i + 1]!;
    const type = remap.types[data[i + 3]!] ?? -1;
    if (type < 0) continue;
    let modifiers = 0;
    for (let bit = 0; bit < remap.modifiers.length; bit++) {
      const target = remap.modifiers[bit]!;
      if (target >= 0 && data[i + 4]! & (1 << bit)) modifiers |= 1 << target;
    }
    out.push(line - lastLine, line === lastLine ? character - lastCharacter : character, data[i + 2]!, type, modifiers);
    lastLine = line;
    lastCharacter = character;
  }
  return out;
}
