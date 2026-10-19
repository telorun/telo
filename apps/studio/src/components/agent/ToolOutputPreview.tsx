import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Copy, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A tool call's details held to a few lines in the transcript, the rest in a
 * dialog. `anchor: "end"` keeps the last lines in view — where a command says
 * how it went. The dialog is offered when the preview overflows, or always
 * with `offerFull` (the preview already left something out).
 */
export function ToolOutputPreview({
  title,
  description,
  full,
  copyText,
  offerFull = false,
  anchor = "start",
  children,
}: {
  title: string;
  description?: string;
  full?: ReactNode;
  copyText?: string;
  offerFull?: boolean;
  anchor?: "start" | "end";
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    // The content, not the box's scrollHeight: overflow clipped at the start is not counted there.
    const measure = () => setOverflows(content.offsetHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const copy = () => {
    if (copyText === undefined) return;
    navigator.clipboard.writeText(copyText).then(
      () => toast.success("Copied"),
      (err: unknown) => toast.error(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  return (
    <>
      <div ref={outer} className={cn("relative max-h-40 overflow-hidden", anchor === "end" && "flex flex-col justify-end")}>
        <div ref={inner} className="shrink-0 space-y-2">
          {children}
        </div>
        {overflows && (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 h-8 from-background to-transparent",
              anchor === "end" ? "top-0 bg-gradient-to-b" : "bottom-0 bg-gradient-to-t",
            )}
          />
        )}
      </div>
      {(overflows || offerFull) && (
        <Button variant="ghost" size="xs" className="mt-1" onClick={() => setOpen(true)}>
          <Maximize2 className="size-3" />
          View full output
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
          <div className="min-w-0 space-y-1 pr-8">
            <DialogTitle className="truncate font-mono text-sm">{title}</DialogTitle>
            <DialogDescription className={cn("truncate font-mono text-xs", !description && "sr-only")}>
              {description || `Everything ${title} returned`}
            </DialogDescription>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-auto text-xs">{full ?? children}</div>
          {copyText !== undefined && (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={copy}>
                <Copy className="size-3.5" />
                Copy
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
