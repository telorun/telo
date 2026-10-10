import { TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

interface RegionErrorBoundaryProps {
  /** What failed, as the reader would call it: "graph", "detail panel". */
  region: string;
  /** A change clears the failure — the thing that failed is no longer shown. */
  resetKey?: unknown;
  className?: string;
  children: ReactNode;
}

interface RegionErrorBoundaryState {
  error: Error | null;
  resetKey: unknown;
}

/**
 * Keeps a render failure inside the region it happened in.
 *
 * React unmounts the whole tree on an error no boundary catches, which is a
 * blank page with the workspace behind it. A region that fails says so in its
 * own place, with the error, and everything beside it keeps working. React
 * still reports the error to the console.
 */
export class RegionErrorBoundary extends Component<
  RegionErrorBoundaryProps,
  RegionErrorBoundaryState
> {
  state: RegionErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<RegionErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: RegionErrorBoundaryProps,
    state: RegionErrorBoundaryState,
  ): Partial<RegionErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { error: null, resetKey: props.resetKey };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto bg-zinc-50 p-6 text-center dark:bg-zinc-900",
          this.props.className,
        )}
      >
        <TriangleAlert className="size-5 shrink-0 text-amber-500" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          The {this.props.region} could not be displayed
        </p>
        <p className="max-w-md font-mono text-xs break-words text-zinc-500">{error.message}</p>
        <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
