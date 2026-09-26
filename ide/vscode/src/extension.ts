import {
  HubClient,
  LanguageRouter,
  createInProcessTransports,
  type StoredResolutions,
} from "@telorun/language-host";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { ExecuteCommandRequest, LanguageClient } from "vscode-languageclient/node";
import { FileEngineCache } from "./file-engine-cache.js";
import { kernelRemoteReader } from "./kernel-remote-reader.js";
import { NodeAdapter } from "./node-adapter.js";
import { nodeEngineSpawner } from "./node-engine-spawner.js";
import { SELECT_VERSION_COMMAND, TeloVersionStatus, configuredPin } from "./telo-version-status.js";

// Broad signature for the language-promote check: any line declaring a
// module-prefixed PascalCase kind (`Run.Sequence`, `Http.Server`), which also
// catches partials included through `include:`. Single-word kinds
// (`Pod`/`Service`) and lowercased `kustomize.config.k8s.io/...` strings don't
// match.
const TELO_PARTIAL_KIND_RE = /^kind:\s+[A-Z]\w*\.\w+/m;

const REFRESH_IMPORT_UPGRADES = "telo.refreshImportUpgrades";
/** `workspaceState` key of this workspace's Auto resolutions. */
const RESOLUTIONS_KEY = "telo.ownerEngines";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let client: LanguageClient | undefined;

function hubUrl(): string {
  return vscode.workspace.getConfiguration("telo").get<string>("hubUrl") ?? "https://telo.sh";
}

function importUpgradesEnabled(): boolean {
  return vscode.workspace.getConfiguration("telo").get<boolean>("importUpgrades.enabled") ?? true;
}

/**
 * Promote a `yaml` document to the `telo` language id when it declares a Telo
 * kind, so Red Hat's YAML extension (scoped to `yaml`) stops reporting `!cel`
 * and `!ref` as unresolved tags. `telo.yaml` / `*.telo.yaml` are promoted by
 * their filename pattern already.
 */
async function promoteToTelo(document: vscode.TextDocument): Promise<void> {
  if (document.languageId !== "yaml" || !TELO_PARTIAL_KIND_RE.test(document.getText())) return;
  await vscode.languages.setTextDocumentLanguage(document, "telo");
}

/**
 * The extension is an LSP client and nothing else: every diagnostic and
 * language feature comes from the telo engine the router chose for the
 * document's module, running in a worker. This file wires the editor to the
 * router and the router to this machine — files, transports, the hub, the
 * engine cache — and shows which telo each module is edited against.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Telo", { log: true });
  context.subscriptions.push(output);

  const engines = new FileEngineCache(path.join(context.globalStorageUri.fsPath, "engines"));
  const transports = createInProcessTransports();
  const router = new LanguageRouter({
    client: transports.server,
    files: new NodeAdapter(),
    remote: kernelRemoteReader(),
    hub: new HubClient({ url: hubUrl }),
    resolutions: {
      read: async () => context.workspaceState.get<StoredResolutions>(RESOLUTIONS_KEY),
      write: async (resolutions) => context.workspaceState.update(RESOLUTIONS_KEY, resolutions),
    },
    spawner: nodeEngineSpawner,
    engineCache: engines,
    catalogCache: engines,
    bundled: {
      load: async () => new Uint8Array(await fs.readFile(context.asAbsolutePath("dist/engine/language-server.mjs"))),
    },
    pin: configuredPin(),
  });

  const status = new TeloVersionStatus(router);
  context.subscriptions.push(
    status,
    router.onStatus((s) => status.show(s)),
    vscode.commands.registerCommand(SELECT_VERSION_COMMAND, () => status.select()),
  );

  client = new LanguageClient(
    "telo",
    "Telo",
    async () => transports.client,
    {
      documentSelector: [
        { scheme: "file", language: "telo" },
        { scheme: "file", language: "yaml" },
      ],
      outputChannel: output,
      middleware: {
        // The switch stops the lenses — and with them every version lookup the
        // engine would make for them.
        provideCodeLenses: (document, token, next) => (importUpgradesEnabled() ? next(document, token) : []),
      },
    },
  );

  const refreshImportUpgrades = () =>
    client
      ?.sendRequest(ExecuteCommandRequest.type, { command: REFRESH_IMPORT_UPGRADES, arguments: [] })
      .catch((error) => output.appendLine(`telo: could not refresh import upgrades: ${errorText(error)}`));

  const showActive = (editor: vscode.TextEditor | undefined) =>
    router.setActiveDocument(editor?.document.uri.toString());

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(showActive),
    vscode.workspace.onDidOpenTextDocument((document) =>
      promoteToTelo(document).catch((error) => output.appendLine(`telo: ${errorText(error)}`)),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("telo.version")) {
        router
          .setPin(configuredPin())
          .catch((error) => output.appendLine(`telo: could not apply telo.version: ${errorText(error)}`));
      }
      if (event.affectsConfiguration("telo.hubUrl") || event.affectsConfiguration("telo.importUpgrades")) {
        void refreshImportUpgrades();
      }
    }),
  );

  await client.start();
  for (const document of vscode.workspace.textDocuments) await promoteToTelo(document);
  showActive(vscode.window.activeTextEditor);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
