import { act } from "react";
import type { Rendered } from "./harness.js";

/** An intersection observer the test moves in and out of view. */
export class FakeIntersections {
  static all: FakeIntersections[] = [];
  readonly targets: Element[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersections.all.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    FakeIntersections.all = FakeIntersections.all.filter((each) => each !== this);
  }
  /** Say that `target` is, or is not, in view. */
  static async show(target: Element, isIntersecting: boolean, rendered: Rendered) {
    for (const observer of FakeIntersections.all.filter((each) => each.targets.includes(target))) {
      await act(async () => observer.callback([{ target, isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver));
    }
    await rendered.settle();
  }
}
