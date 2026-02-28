import type {
    ControllerContext,
    ModuleCreateContext,
    ResourceInstance,
    RuntimeResource,
} from "@telorun/sdk";
import * as fs from "fs/promises";
import * as path from "path";

// Resource Type Definitions
type TracingProviderResource = RuntimeResource & {
  exporters: string[];
  events?: string[];
  filters?: {
    minLevel?: "debug" | "info" | "error";
  };
  buffer?: {
    maxSize?: number;
    retryAttempts?: number;
    retryDelay?: number;
  };
};

type FileExporterResource = RuntimeResource & {
  path: string;
  format?: "json" | "ndjson" | "text";
  mode?: "append" | "overwrite";
  pretty?: boolean;
};

// Trace Event Structure
interface TraceEvent {
  timestamp: string;
  event: string;
  kind?: string;
  name?: string;
  payload?: any;
  level: "info" | "debug" | "error";
}

// Event Buffer for retry logic
class EventBuffer {
  private buffer: Array<{ event: TraceEvent; attempts: number }> = [];
  private maxSize: number;
  private retryAttempts: number;
  private retryDelay: number;

  constructor(maxSize: number, retryAttempts: number, retryDelay: number) {
    this.maxSize = maxSize;
    this.retryAttempts = retryAttempts;
    this.retryDelay = retryDelay;
  }

  add(event: TraceEvent): void {
    // If buffer is full, remove oldest event
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }
    this.buffer.push({ event, attempts: 0 });
  }

  async processWithExporter(exporter: (event: TraceEvent) => Promise<void>): Promise<void> {
    const failedEvents: Array<{ event: TraceEvent; attempts: number }> = [];

    for (const item of this.buffer) {
      try {
        await exporter(item.event);
      } catch (error) {
        item.attempts++;
        if (item.attempts < this.retryAttempts) {
          failedEvents.push(item);
          // Wait before next retry
          if (this.retryDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
          }
        } else {
          // Max retries reached, log and drop event
          console.error(
            `[Tracing] Failed to export event after ${this.retryAttempts} attempts:`,
            error,
          );
        }
      }
    }

    // Replace buffer with only failed events that can be retried
    this.buffer = failedEvents;
  }

  size(): number {
    return this.buffer.length;
  }
}

// File Exporter Implementation
class FileExporter {
  private filePath: string;
  private format: "json" | "ndjson" | "text";
  private pretty: boolean;
  private events: TraceEvent[] = [];

  constructor(resource: FileExporterResource) {
    this.filePath = resource.path;
    this.format = resource.format || "ndjson";
    this.pretty = resource.pretty || false;
  }

  async init(mode: "append" | "overwrite"): Promise<void> {
    // Ensure directory exists
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    // Initialize file based on mode
    if (mode === "overwrite") {
      await fs.writeFile(this.filePath, "", "utf-8");
    }
  }

  async export(event: TraceEvent): Promise<void> {
    const line = this.formatEvent(event);
    await fs.appendFile(this.filePath, line + "\n", "utf-8");
  }

  private formatEvent(event: TraceEvent): string {
    switch (this.format) {
      case "json":
        if (this.events.length === 0) {
          this.events.push(event);
          return this.pretty ? JSON.stringify([event], null, 2) : JSON.stringify([event]);
        }
        // For JSON format, we need to maintain the array structure
        // This is a simplified approach; ideally would rewrite the entire file
        return this.pretty ? "," + JSON.stringify(event, null, 2) : "," + JSON.stringify(event);

      case "ndjson":
        return JSON.stringify(event);

      case "text":
        return `[${event.timestamp}] ${event.event}${event.kind ? ` (${event.kind}${event.name ? `.${event.name}` : ""})` : ""}: ${JSON.stringify(event.payload || {})}`;

      default:
        return JSON.stringify(event);
    }
  }
}

// Pattern Matching Helper
function matchesPattern(eventName: string, pattern: string): boolean {
  // Convert glob pattern to regex
  if (pattern === "*") {
    return true;
  }

  // Escape special regex characters except * and ?
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(eventName);
}

// Parse resource reference (e.g., "Tracing.FileExporter.myExporter")
function parseResourceRef(ref: string): { kind: string; name: string } {
  const lastDot = ref.lastIndexOf(".");
  if (lastDot === -1) {
    return { kind: "", name: ref };
  }
  return {
    kind: ref.substring(0, lastDot),
    name: ref.substring(lastDot + 1),
  };
}

// Module Registration
export function register(ctx: ControllerContext): void {
  // No global registration needed for now
}

// Resource Creation
export function create(
  resource: RuntimeResource,
  ctx: ModuleCreateContext,
): ResourceInstance | null {
  // Handle Tracing.FileExporter
  if (resource.kind === "Tracing.FileExporter") {
    const exporterResource = resource as FileExporterResource;
    const fileExporter = new FileExporter(exporterResource);
    const mode = exporterResource.mode || "append";

    return {
      init: async () => {
        await fileExporter.init(mode);
      },
      teardown: async () => {
        // No cleanup needed for file exporter
      },
    };
  }

  // Handle Tracing.Provider
  if (resource.kind === "Tracing.Provider") {
    const provider = resource as TracingProviderResource;
    const eventPatterns = provider.events || ["*"];
    const exporterRefs = provider.exporters || [];
    const minLevel = provider.filters?.minLevel || "debug";

    // Buffer configuration
    const bufferConfig = provider.buffer || {};
    const maxSize = bufferConfig.maxSize || 1000;
    const retryAttempts = bufferConfig.retryAttempts || 3;
    const retryDelay = bufferConfig.retryDelay || 1000;

    const eventBuffer = new EventBuffer(maxSize, retryAttempts, retryDelay);

    // Resolve exporter resources
    const exporters: FileExporter[] = [];
    for (const ref of exporterRefs) {
      const { kind, name } = parseResourceRef(ref);
      const exporterResources = ctx.getResources(kind);
      const exporterResource = exporterResources.find((r) => r.metadata.name === name) as
        | FileExporterResource
        | undefined;

      if (!exporterResource) {
        throw new Error(`Exporter not found: ${ref} (kind: ${kind}, name: ${name})`);
      }

      if (exporterResource.kind === "Tracing.FileExporter") {
        exporters.push(new FileExporter(exporterResource));
      }
    }

    // Initialize exporters
    const initExporters = async () => {
      for (let i = 0; i < exporterRefs.length; i++) {
        const ref = exporterRefs[i];
        const { kind, name } = parseResourceRef(ref);
        const exporterResources = ctx.getResources(kind);
        const exporterResource = exporterResources.find((r) => r.metadata.name === name) as
          | FileExporterResource
          | undefined;

        if (exporterResource && exporterResource.kind === "Tracing.FileExporter") {
          const mode = exporterResource.mode || "append";
          await exporters[i].init(mode);
        }
      }
    };

    // Event handler factory
    const createEventHandler = (eventName: string) => {
      return async (payload?: any) => {
        // Check if event matches any pattern
        const matches = eventPatterns.some((pattern) => matchesPattern(eventName, pattern));
        if (!matches) {
          return;
        }

        // Determine event level and kind/name
        let level: "info" | "debug" | "error" = "info";
        let kind: string | undefined;
        let name: string | undefined;

        if (eventName.startsWith("Kernel.")) {
          level = "info";
        } else if (payload?.error) {
          level = "error";
        } else {
          level = "debug";
        }

        // Extract kind and name from payload if available
        if (payload?.resource) {
          kind = payload.resource.kind;
          name = payload.resource.metadata?.name;
        }

        // Apply level filter
        const levels = ["debug", "info", "error"];
        const minLevelIndex = levels.indexOf(minLevel);
        const eventLevelIndex = levels.indexOf(level);
        if (eventLevelIndex < minLevelIndex) {
          return;
        }

        // Create trace event
        const traceEvent: TraceEvent = {
          timestamp: new Date().toISOString(),
          event: eventName,
          kind,
          name,
          payload,
          level,
        };

        // Add to buffer
        eventBuffer.add(traceEvent);

        // Try to export immediately
        await eventBuffer.processWithExporter(async (event) => {
          for (const exporter of exporters) {
            await exporter.export(event);
          }
        });
      };
    };

    // Event handler storage for cleanup
    const handlers: Array<{
      event: string;
      handler: (payload?: any) => void | Promise<void>;
    }> = [];

    return {
      init: async () => {
        // Initialize exporters
        await initExporters();

        // Register listeners for Runtime events
        const runtimeEvents = [
          "Kernel.Starting",
          "Kernel.Started",
          "Kernel.Blocked",
          "Kernel.Unblocked",
        ];

        for (const eventName of runtimeEvents) {
          const shouldListen = eventPatterns.some((pattern) => matchesPattern(eventName, pattern));
          if (shouldListen) {
            const handler = createEventHandler(eventName);
            ctx.on(eventName, handler);
            handlers.push({ event: eventName, handler });
          }
        }

        // Register listeners for resource lifecycle events
        // Get all resource kinds from registry
        const resourceKinds = new Set<string>();
        for (const [kind] of ctx.kernel.registry) {
          resourceKinds.add(kind);
        }

        for (const kind of resourceKinds) {
          const initEvent = `${kind}.Initialized`;
          const teardownEvent = `${kind}.Teardown`;

          if (eventPatterns.some((pattern) => matchesPattern(initEvent, pattern))) {
            const handler = createEventHandler(initEvent);
            ctx.on(initEvent, handler);
            handlers.push({ event: initEvent, handler });
          }

          if (eventPatterns.some((pattern) => matchesPattern(teardownEvent, pattern))) {
            const handler = createEventHandler(teardownEvent);
            ctx.on(teardownEvent, handler);
            handlers.push({ event: teardownEvent, handler });
          }
        }

        // Register wildcard listener if "*" pattern is used
        if (eventPatterns.includes("*")) {
          // Note: This is a simplified approach
          // A more sophisticated implementation would intercept all events dynamically
          console.log('[Tracing] Listening to all events with pattern "*"');
        }
      },
      teardown: async () => {
        // Unregister all handlers
        for (const { event, handler } of handlers) {
          ctx.off(event, handler);
        }

        // Flush remaining buffered events
        if (eventBuffer.size() > 0) {
          await eventBuffer.processWithExporter(async (event) => {
            for (const exporter of exporters) {
              await exporter.export(event);
            }
          });
        }
      },
    };
  }

  return null;
}
