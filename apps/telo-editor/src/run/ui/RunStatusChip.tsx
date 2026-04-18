import type { RunStatus } from "../types";

interface Props {
  status: RunStatus;
}

export function RunStatusChip({ status }: Props) {
  const { label, className } = describe(status);
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${className}`}
    >
      {label}
    </span>
  );
}

function describe(status: RunStatus): { label: string; className: string } {
  switch (status.kind) {
    case "starting":
      return {
        label: "Starting",
        className:
          "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
      };
    case "running":
      return {
        label: "Running",
        className:
          "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200",
      };
    case "exited":
      return status.code === 0
        ? {
            label: "Exited 0",
            className:
              "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200",
          }
        : {
            label: `Exited ${status.code}`,
            className:
              "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200",
          };
    case "failed":
      return {
        label: "Failed",
        className:
          "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200",
      };
    case "stopped":
      return {
        label: "Stopped",
        className:
          "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200",
      };
  }
}
