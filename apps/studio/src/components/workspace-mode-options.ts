import { Bot, HardDrive, Play, type LucideIcon } from "lucide-react";

import type { WorkspaceMode } from "../run";

/** The three ways a workspace is used, as the mode dialog and the workspace
 *  menu offer them. */
export const WORKSPACE_MODE_OPTIONS: ReadonlyArray<{
  mode: WorkspaceMode;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    mode: "agent",
    label: "Agent",
    description: "A runner session with the authoring agent beside your applications. Run them, and ask the agent to build.",
    icon: Bot,
  },
  {
    mode: "manual",
    label: "Manual",
    description: "A runner session for running your applications, with no agent.",
    icon: Play,
  },
  {
    mode: "device",
    label: "Only on this device",
    description: "No runner is contacted at all: you edit here, and nothing runs.",
    icon: HardDrive,
  },
];
