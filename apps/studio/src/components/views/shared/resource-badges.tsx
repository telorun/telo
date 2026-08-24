function capabilityLabel(cap: string): string {
  const dot = cap.lastIndexOf(".");
  return dot >= 0 ? cap.slice(dot + 1) : cap;
}

const capabilityColors: Record<string, string> = {
  Service: "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200",
  Runnable: "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200",
  Invocable: "bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-200",
  Provider: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/60 dark:text-cyan-200",
  Mount: "bg-pink-100 text-pink-700 dark:bg-pink-900/60 dark:text-pink-200",
  Type: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export function CapabilityBadge({ capability }: { capability: string }) {
  const label = capabilityLabel(capability);
  const color =
    capabilityColors[label] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${color}`}>
      {label}
    </span>
  );
}

export function TopologyBadge({ topology }: { topology: string }) {
  return (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-900/60 dark:text-amber-200">
      {topology}
    </span>
  );
}
