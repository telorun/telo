import { InvokeError, isInvokeError, RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { structuredNapiController } from "../src/controller-loaders/napi-loader.js";

// What the Rust SDK's napi backend throws for a controller's own `Err`: an
// Error whose `code` is the controller's code, carrying the non-enumerable
// marker `sdk/rust/src/backend/napi.rs` defines.
function controllerError(code: string, message: string): Error {
  const err = Object.assign(new Error(message), { code });
  Object.defineProperty(err, "teloControllerError", { value: true });
  return err;
}

// What napi throws for anything else: a coded Error with no marker.
function napiError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// Stands in for a napi class: the method reads a private field, so it fails
// unless it is called on the instance itself — as a napi method unwrapping its
// native receiver does.
class FakeNapiInstance {
  #thrown: unknown;
  constructor(thrown: unknown) {
    this.#thrown = thrown;
  }
  invoke(input: unknown): unknown {
    if (this.#thrown !== undefined) throw this.#thrown;
    return { echoed: input };
  }
  snapshot(): unknown {
    if (this.#thrown !== undefined) throw this.#thrown;
    return { ok: true };
  }
  async run(): Promise<void> {
    if (this.#thrown !== undefined) throw this.#thrown;
  }
}

function controllerThrowing(thrown: unknown) {
  return structuredNapiController({
    args: { verbose: { type: "boolean" } },
    register: () => {
      if (thrown !== undefined) throw thrown;
    },
    create: () => new FakeNapiInstance(thrown),
  });
}

async function instanceThrowing(thrown: unknown): Promise<any> {
  return controllerThrowing(thrown).create!({} as any, {} as any);
}

function caught(call: () => unknown): unknown {
  try {
    call();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("napi loader re-raises a controller's own error as an InvokeError", () => {
  it("re-raises a marked error thrown by invoke", async () => {
    const original = controllerError("ERR_OUTPUT_NOT_TEXT", "not text");
    const instance = await instanceThrowing(original);
    const err = caught(() => instance.invoke({ output: 1 }));
    expect(isInvokeError(err)).toBe(true);
    expect(err).toMatchObject({ code: "ERR_OUTPUT_NOT_TEXT", message: "not text" });
    expect((err as InvokeError).cause).toBe(original);
  });

  it("re-raises from snapshot, register and create", async () => {
    const original = controllerError("ERR_X", "boom");
    const controller = controllerThrowing(original);
    const instance = (await controller.create!({} as any, {} as any)) as any;
    for (const err of [
      caught(() => instance.snapshot()),
      caught(() => controller.register!({} as any)),
      caught(() =>
        structuredNapiController({
          create: () => {
            throw original;
          },
        }).create!({} as any, {} as any),
      ),
    ]) {
      expect(isInvokeError(err)).toBe(true);
      expect(err).toMatchObject({ code: "ERR_X", message: "boom" });
    }
  });

  it("re-raises an asynchronous rejection", async () => {
    const instance = await instanceThrowing(controllerError("ERR_ASYNC", "later"));
    const err = await instance.run().then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    expect(isInvokeError(err)).toBe(true);
    expect(err).toMatchObject({ code: "ERR_ASYNC", message: "later" });
  });

  it("rethrows an unmarked error unchanged, whatever its code", async () => {
    for (const original of [
      new Error("no code"),
      // A value the bridge cannot convert; napi-derive's argument check; a
      // hand-written crate's `napi::Error::from_reason`.
      napiError("InvalidArg", "invalid type: byte array, expected any valid JSON value"),
      napiError("ObjectExpected", "expected an object"),
      napiError("GenericFailure", "boom"),
      napiError("ERR_LOOKS_LIKE_A_CODE", "spelled like a controller code, but unmarked"),
    ]) {
      const instance = await instanceThrowing(original);
      expect(caught(() => instance.invoke({}))).toBe(original);
    }
  });

  it("rethrows an already-structured error unchanged", async () => {
    for (const original of [
      new InvokeError("ERR_DOMAIN", "declared"),
      new RuntimeError("ERR_EXECUTION_FAILED", "kernel error crossing back"),
    ]) {
      const instance = await instanceThrowing(original);
      expect(caught(() => instance.invoke({}))).toBe(original);
    }
  });

  it("keeps results, the receiver, identity and every other member", async () => {
    const raw = {
      args: { verbose: { type: "boolean" } },
      create: () => new FakeNapiInstance(undefined),
    };
    expect(structuredNapiController(raw)).toBe(structuredNapiController(raw));
    // The controller registry keeps a copy of the controller's own enumerable
    // members; the wrapped hooks and every other member must survive it.
    const controller = { ...structuredNapiController(raw) };
    expect(controller.args).toBe(raw.args);
    const copied = { ...controllerThrowing(controllerError("E", "m")) };
    expect(isInvokeError(caught(() => copied.register!({} as any)))).toBe(true);
    const instance = (await controller.create!({} as any, {} as any)) as any;
    expect(instance).toBeInstanceOf(FakeNapiInstance);
    expect(instance.invoke("hi")).toEqual({ echoed: "hi" });
    expect(instance.snapshot()).toEqual({ ok: true });
  });
});
