import { RuntimeEvent } from "./runtime-event.js";

export interface ControllerContext {
  on(event: string, handler: (event: RuntimeEvent) => void | Promise<void>): void;
  emit(event: string, payload?: any, metadata?: Record<string, any>): void;
  acquireHold(reason?: string): () => void;
  requestExit(code: number): void;
  expandValue(value: any, context: Record<string, any>): any;
}
