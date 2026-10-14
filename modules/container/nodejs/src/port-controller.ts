import { RuntimeError, type KindRef, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { isStartedContainer, type StartedContainer } from "./instance-controller.js";

interface PortResource {
  metadata: { name: string; module?: string };
  container: StartedContainer | KindRef<StartedContainer>;
  port: unknown;
}

/**
 * Container.Port — the address one published port is reached at, reported as
 * observed state from `init()`, which runs once the container is ready.
 */
class ContainerPort implements ResourceInstance {
  private readonly describe: string;
  private readonly port: number;

  constructor(
    private readonly resource: PortResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `Container.Port "${resource.metadata.name}"`;
    this.port = Number(resource.port);
  }

  async init(): Promise<void> {
    const container = this.ctx.resolveRef(
      this.resource.container,
      isStartedContainer,
      () => `${this.describe}: 'container'`,
      "Container.Instance",
    );
    if (!container.ports.includes(this.port)) {
      throw new RuntimeError(
        "ERR_CONTAINER_PORT_NOT_EXPOSED",
        `${this.describe}: names port ${this.port}, which ${container.describe} does not publish ` +
          `(it publishes ${container.ports.length ? container.ports.join(", ") : "no ports"}).`,
      );
    }
    const { host, port } = container.binding(this.port);
    await this.ctx.setStatus({ host, port });
  }

  snapshot(): Record<string, unknown> {
    return { port: this.port };
  }
}

export async function create(resource: PortResource, ctx: ResourceContext): Promise<ContainerPort> {
  return new ContainerPort(resource, ctx);
}
