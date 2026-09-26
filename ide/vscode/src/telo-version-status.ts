import {
  describeAutoMark,
  describeTeloStatus,
  describeVersionMark,
  type LanguageRouter,
  type StatusError,
  type TeloStatus,
} from "@telorun/language-host";
import * as vscode from "vscode";

export const SELECT_VERSION_COMMAND = "telo.selectVersion";

const HOST = { product: "this extension", setting: "the telo.version setting" };

/** `telo.version`: an exact version, or `undefined` for Auto. */
export function configuredPin(): string | undefined {
  const value = vscode.workspace.getConfiguration("telo").get<string>("version")?.trim();
  return !value || value === "auto" ? undefined : value;
}

/**
 * The "Telo X" status item, the one notification per error cause, and the
 * version picker. Everything shown is the router's status for the active
 * document in language-host's words; this adds only icons and actions.
 */
export class TeloVersionStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly notified = new Set<string>();

  constructor(private readonly router: LanguageRouter) {
    this.item.command = SELECT_VERSION_COMMAND;
  }

  show(status: TeloStatus): void {
    const { label, detail } = describeTeloStatus(status, HOST);
    const icon = status.error ? (status.version === undefined ? "$(error) " : "$(warning) ") : status.starting ? "$(loading~spin) " : "";
    this.item.text = `${icon}${label}`;
    this.item.tooltip = detail;
    this.item.show();
    if (status.error) void this.notifyOnce(status.error);
  }

  private async notifyOnce(error: StatusError): Promise<void> {
    if (error.kind === "nothing-satisfies") return;
    const key = JSON.stringify(error);
    if (this.notified.has(key)) return;
    this.notified.add(key);
    const choice = await vscode.window.showErrorMessage(`telo: ${error.message}`, "Select version", "Retry");
    if (choice === "Select version") await vscode.commands.executeCommand(SELECT_VERSION_COMMAND);
    if (choice === "Retry") {
      this.notified.delete(key);
      await this.router.retry();
    }
  }

  /** Quick pick: Auto, then every known version newest first, marked. */
  async select(): Promise<void> {
    const marks = await this.router.markVersions();
    type Item = vscode.QuickPickItem & { value: string };
    const auto = describeAutoMark(marks);
    const items: Item[] = [
      { label: auto.label, description: auto.detail || undefined, value: "auto" },
      ...marks.versions.map((v) => {
        const { label, detail } = describeVersionMark(v);
        return { label, description: detail, value: v.version };
      }),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Telo version to edit against",
      placeHolder: `current: ${configuredPin() ?? "auto"}`,
    });
    if (!picked) return;
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration("telo").update("version", picked.value, target);
  }

  dispose(): void {
    this.item.dispose();
  }
}
