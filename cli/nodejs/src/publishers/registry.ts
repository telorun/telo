import type { ControllerPublisher } from "./interface.js";
import { npmPublisher } from "./npm.js";

const publishers: ControllerPublisher[] = [npmPublisher];

export function getPublisher(type: string): ControllerPublisher | undefined {
  return publishers.find((p) => p.type === type);
}
