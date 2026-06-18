import { RuntimeEvent } from "@telorun/sdk";

type EventHandler = (payload?: any) => void | Promise<void>;

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  private validateEventName(event: string): void {
    if (
      event === "" ||
      !/^(\*|[A-Za-z_][A-Za-z0-9_]*)(\.(\*|[A-Za-z_][A-Za-z0-9_]*))*$/.test(event)
    ) {
      throw new Error(`Invalid event name "${event}". Expected format "Text.Text" with no spaces.`);
    }
  }

  private matchesPattern(pattern: string, event: string): boolean {
    if (pattern === "*") {
      return true;
    }
    if (pattern === event) {
      return true;
    }
    if (!pattern.includes("*")) {
      return false;
    }
    const patternParts = pattern.split(".");
    const eventParts = event.split(".");
    if (patternParts.length !== eventParts.length) {
      return false;
    }
    for (let i = 0; i < patternParts.length; i += 1) {
      const part = patternParts[i];
      if (part === "*") {
        continue;
      }
      if (part !== eventParts[i]) {
        return false;
      }
    }
    return true;
  }

  on(event: string, handler: EventHandler): void {
    this.validateEventName(event);
    const set = this.handlers.get(event) || new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  once(event: string, handler: EventHandler): void {
    this.validateEventName(event);
    const wrapper: EventHandler = async (payload?: any) => {
      this.off(event, wrapper);
      await handler(payload);
    };
    this.on(event, wrapper);
  }

  off(event: string, handler: EventHandler): void {
    this.validateEventName(event);
    const set = this.handlers.get(event);
    if (!set) {
      return;
    }
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(event);
    }
  }

  async emit(event: string, payload?: any, metadata?: any): Promise<void> {
    // O(1) idle short-circuit: with no subscriber at all — the common case when
    // no debug consumer is attached — emitting costs a single integer compare,
    // no map walk and no allocation. This is what keeps routing every dispatch
    // through the instrumented chokepoint effectively free when nobody listens.
    if (this.handlers.size === 0) return;
    const handlers: EventHandler[] = [];
    for (const [pattern, set] of this.handlers.entries()) {
      if (!this.matchesPattern(pattern, event)) {
        continue;
      }
      for (const handler of set) {
        handlers.push(handler);
      }
    }
    if (handlers.length === 0) {
      return;
    }
    const evt: RuntimeEvent = { name: event, payload, metadata };
    for (const handler of handlers) {
      await handler(evt);
    }
  }

  hasHandlers(event: string): boolean {
    for (const [pattern, set] of this.handlers.entries()) {
      if (set.size > 0 && this.matchesPattern(pattern, event)) {
        return true;
      }
    }
    return false;
  }
}
