import { useState } from "react";
import { Button } from "../../components/ui/button";

interface Props {
  adapterDisplayName: string;
  message: string;
  remediation?: string;
  onRecheck?: () => Promise<void>;
  onClose: () => void;
}

export function AdapterUnavailable({
  adapterDisplayName,
  message,
  remediation,
  onRecheck,
  onClose,
}: Props) {
  const [rechecking, setRechecking] = useState(false);

  async function handleRecheck() {
    if (!onRecheck) return;
    setRechecking(true);
    try {
      await onRecheck();
    } finally {
      setRechecking(false);
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 p-6 text-center dark:bg-zinc-900">
      <div className="max-w-md">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {adapterDisplayName}
        </p>
        <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{message}</p>
        {remediation && (
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{remediation}</p>
        )}
      </div>
      <div className="flex gap-2">
        {onRecheck && (
          <Button size="sm" onClick={handleRecheck} disabled={rechecking}>
            {rechecking ? "Checking…" : "Recheck"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
