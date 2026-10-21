import { createHash } from "node:crypto";
import { integerInput, InvokeError, type ResourceInstance } from "@telorun/sdk";

interface MineInputs {
  text: string;
  difficulty: unknown;
}

interface MineOutputs {
  nonce: number;
  hash: string;
  elapsedMs: number;
}

class MineResource implements ResourceInstance<MineInputs, MineOutputs> {
  async invoke({ text, difficulty }: MineInputs): Promise<MineOutputs> {
    const bits = integerInput(difficulty);
    if (bits === undefined) {
      throw new InvokeError("ERR_INPUT_INVALID", "`difficulty` must be an integer");
    }
    const started = performance.now();
    for (let nonce = 0; ; nonce++) {
      const digest = createHash("sha256").update(`${text}${nonce}`).digest();
      if (leadingZeroBits(digest) >= bits) {
        return { nonce, hash: digest.toString("hex"), elapsedMs: performance.now() - started };
      }
    }
  }
}

function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte !== 0) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
}

export async function create(): Promise<MineResource> {
  return new MineResource();
}
