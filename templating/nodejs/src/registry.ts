import type { TemplatingEngine } from "./engine.js";

export class TemplatingEngineRegistry {
  private readonly engines = new Map<string, TemplatingEngine>();

  register(engine: TemplatingEngine): void {
    if (this.engines.has(engine.name)) {
      throw new Error(`Templating engine '${engine.name}' is already registered.`);
    }
    this.engines.set(engine.name, engine);
  }

  get(name: string): TemplatingEngine | undefined {
    return this.engines.get(name);
  }

  has(name: string): boolean {
    return this.engines.has(name);
  }

  /** All registered engines in registration order. */
  list(): readonly TemplatingEngine[] {
    return [...this.engines.values()];
  }
}
