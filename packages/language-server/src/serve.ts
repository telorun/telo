import {
  TELO_EDITOR_PROTOCOL,
  TELO_SERVER_NAME,
  TeloCommand,
  TeloMethod,
  type TeloExperimentalCapabilities,
} from "@telorun/editor-protocol";
import {
  CodeActionKind,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
  type InitializeResult,
} from "vscode-languageserver/browser";
import { TextDocument } from "vscode-languageserver-textdocument";
import { basenameOf, sourceOfUri, uriOfSource } from "./document-uri.js";
import { TELO_ENGINE_VERSION } from "./engine-version.js";
import { PortMessageReader, PortMessageWriter, type EnginePort } from "./engine-port.js";
import { registerCodeActions } from "./features/code-actions.js";
import { COMPLETION_TRIGGERS, registerCompletion } from "./features/completion.js";
import type { ClientSupport, FeatureContext } from "./features/context.js";
import { registerDefinition } from "./features/definition.js";
import { registerHover } from "./features/hover.js";
import { registerImportUpgrades } from "./features/import-upgrades.js";
import { registerRename } from "./features/rename.js";
import { SEMANTIC_TOKENS_LEGEND, registerSemanticTokens } from "./features/semantic-tokens.js";
import { SIGNATURE_HELP_TRIGGERS, registerSignatureHelp } from "./features/signature-help.js";
import { HostClient, errorText } from "./host-client.js";
import { HostManifestSource } from "./host-manifest-source.js";
import { WorkspaceMarkers } from "./workspace-marker.js";
import { WorkspaceSession } from "./workspace-session.js";

export type { EnginePort } from "./engine-port.js";

/**
 * Serve telo's language features over `port` until the host drops it.
 *
 * The engine does no I/O of its own: every file, directory, import and hub
 * answer arrives as a `telo/*` request the host serves, so one build runs in a
 * Web Worker, a browser tab's worker or a Node worker thread alike.
 */
export function serve(port: EnginePort): void {
  const connection = createConnection(new PortMessageReader(port), new PortMessageWriter(port));
  const documents = new TextDocuments(TextDocument);
  const host = new HostClient(connection);
  const client: ClientSupport = { codeLensRefresh: false, semanticTokensRefresh: false };
  let watchedFilesRegistration = false;

  // Resolved lazily so the session's own open buffers are what the source
  // reads first.
  let session: WorkspaceSession;
  const source = new HostManifestSource(host, (s) => session.textOf(s));
  const markers = new WorkspaceMarkers(host);
  const reportSendFailure = (what: string) => (error: unknown) =>
    host.log(`telo: could not send ${what}: ${errorText(error)}`);
  session = new WorkspaceSession(source, markers, {
    publishDiagnostics: (file, diagnostics) =>
      connection
        .sendDiagnostics({ uri: uriOfSource(file), diagnostics })
        .catch(reportSendFailure(`diagnostics for ${file}`)),
    requirements: (params) =>
      connection
        .sendNotification(TeloMethod.requirements, params)
        .catch(reportSendFailure(`${TeloMethod.requirements} for ${params.owner}`)),
    analysed: () => {
      if (!client.semanticTokensRefresh) return;
      connection.languages.semanticTokens.refresh().catch(reportSendFailure("a semantic tokens refresh"));
    },
    failed: (file, error) =>
      connection.console.error(
        `telo: analysing ${file} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      ),
  });

  connection.onInitialize((params): InitializeResult => {
    const workspace = params.capabilities.workspace;
    client.codeLensRefresh = workspace?.codeLens?.refreshSupport === true;
    client.semanticTokensRefresh = workspace?.semanticTokens?.refreshSupport === true;
    watchedFilesRegistration = workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    const experimental: TeloExperimentalCapabilities = {
      telo: { protocol: TELO_EDITOR_PROTOCOL },
    };
    return {
      serverInfo: { name: TELO_SERVER_NAME, version: TELO_ENGINE_VERSION },
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: { triggerCharacters: COMPLETION_TRIGGERS },
        hoverProvider: true,
        definitionProvider: true,
        renameProvider: { prepareProvider: true },
        signatureHelpProvider: { triggerCharacters: SIGNATURE_HELP_TRIGGERS },
        semanticTokensProvider: { legend: SEMANTIC_TOKENS_LEGEND, full: true },
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
        codeLensProvider: { resolveProvider: false },
        executeCommandProvider: { commands: Object.values(TeloCommand) },
        experimental,
      },
    };
  });

  connection.onInitialized(() => {
    // A module appearing on disk moves what the workspace marker reports, and a
    // file changed outside the editor moves every analysis that read it.
    if (!watchedFilesRegistration) return;
    connection.client
      .register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: "**/*.yaml" }] })
      .catch((error: unknown) => host.log(`telo: could not watch workspace files: ${String(error)}`));
  });

  connection.onDidChangeWatchedFiles(({ changes }) => {
    const structural = changes.some(
      (c) => c.type !== FileChangeType.Changed && basenameOf(sourceOfUri(c.uri)) === "telo.yaml",
    );
    if (structural) markers.invalidate();
    session.filesChanged(changes.map((c) => sourceOfUri(c.uri)), structural);
  });

  documents.onDidChangeContent(({ document }) => {
    session.changed(sourceOfUri(document.uri), document.getText());
  });
  documents.onDidClose(({ document }) => session.closed(sourceOfUri(document.uri)));

  const context: FeatureContext = { connection, documents, session, markers, host, client };
  registerCompletion(context);
  registerHover(context);
  registerDefinition(context);
  registerRename(context);
  registerSignatureHelp(context);
  registerSemanticTokens(context);
  registerCodeActions(context);
  registerImportUpgrades(context);

  documents.listen(connection);
  connection.listen();
}
