import { defineConfig } from "vitest/config";

/** The infrastructure-dependent half of the kernel's tests. Serialized: the
 *  cases build images and run containers, and several drive the same Docker
 *  daemon, so parallel files would contend rather than go faster. */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 1_800_000,
  },
});
