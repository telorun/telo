import type { Connection, TextDocuments } from "vscode-languageserver/browser";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { HostClient } from "../host-client.js";
import type { WorkspaceMarkers } from "../workspace-marker.js";
import type { WorkspaceSession } from "../workspace-session.js";

/** What every feature handler is registered against. */
export interface FeatureContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  session: WorkspaceSession;
  markers: WorkspaceMarkers;
  host: HostClient;
  client: ClientSupport;
}

/** What the client said it supports at initialize, where a feature has to ask. */
export interface ClientSupport {
  codeLensRefresh: boolean;
  semanticTokensRefresh: boolean;
}
