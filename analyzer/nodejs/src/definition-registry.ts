import type { ResourceDefinition } from "@telorun/sdk";

/** Pure kind → ResourceDefinition map. No controller loading, no lifecycle. */
export class DefinitionRegistry {
  private readonly defs = new Map<string, ResourceDefinition>();

  register(definition: ResourceDefinition): void {
    const { name, module: mod } = definition.metadata;
    const key = mod ? `${mod}.${name}` : name;
    this.defs.set(key, definition);
  }

  resolve(kind: string): ResourceDefinition | undefined {
    return this.defs.get(kind);
  }

  kinds(): string[] {
    return Array.from(this.defs.keys());
  }
}
