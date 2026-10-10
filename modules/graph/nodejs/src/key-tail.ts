import {
  decodeTypedFrame,
  encodeTypedFrame,
  InvokeError,
  readsTypedFrameGeneration,
  TYPED_FRAME_GENERATION,
} from "@telorun/sdk";

const TAIL = /^([1-9][0-9]{0,8}):([\s\S]*)$/;

/**
 * The key values of a listing's last item, as text: the typed frame of the
 * list, behind the frame generation that wrote it. The frame is one-to-one over
 * the value domain, so a key comes back as the value an operation returned it
 * as. A key outside the domain is refused by the frame's own coded error.
 */
export function encodeKeyTail(keys: readonly unknown[]): string {
  return `${TYPED_FRAME_GENERATION}:${encodeTypedFrame([...keys])}`;
}

/**
 * The key values a tail holds, or undefined when it is not a tail of `arity`
 * values: not a frame, another arity, or a generation this runtime does not
 * read. A caller answers undefined with `cursorInvalid` before any statement,
 * and binds what it does get — never writes it into statement text.
 */
export function decodeKeyTail(tail: string, arity: number): unknown[] | undefined {
  const match = TAIL.exec(tail);
  if (!match) return undefined;
  const generation = Number(match[1]);
  if (!readsTypedFrameGeneration(generation)) return undefined;
  let keys: unknown;
  try {
    keys = decodeTypedFrame(match[2], generation);
  } catch (error) {
    if (error instanceof InvokeError && error.code === "ERR_TYPED_FRAME_UNDECODABLE") {
      return undefined;
    }
    throw error;
  }
  return Array.isArray(keys) && keys.length === arity ? keys : undefined;
}
