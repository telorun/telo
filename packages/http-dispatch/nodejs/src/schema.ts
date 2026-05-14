import { Static, Type } from "@sinclair/typebox";
import { Invocable, KindRef, Ref } from "@telorun/sdk";

/** Per-MIME content-map entry. Buffer-mode responses use `body` (with optional
 *  `schema` for AJV validation); stream-mode responses use `encoder` (a ref to
 *  any `Codec.Encoder` implementation). The two are mutually exclusive per
 *  value — see dispatch logic. `headers` here merge over the entry-level
 *  `headers` (per-MIME wins on conflict). `Content-Type` is forbidden in
 *  headers — the map key IS the canonical Content-Type. */
export const ContentEntry = Type.Object({
  body: Type.Optional(Type.Any()),
  schema: Type.Optional(Type.Any()),
  encoder: Type.Optional(Type.Unsafe<KindRef<Invocable>>(Ref("std/codec#Encoder"))),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type ContentEntry = Static<typeof ContentEntry>;

/** Catches are buffer-mode only — by the time a catch fires the response is
 *  committed pre-stream and there's no upstream iterable to feed an encoder.
 *  Schema-level omission of `encoder` makes that contract enforceable by the
 *  validator (matching the YAML manifest schema in modules/http-server/telo.yaml,
 *  which uses additionalProperties: false on catch content entries). */
export const CatchContentEntry = Type.Omit(ContentEntry, ["encoder"]);
export type CatchContentEntry = Static<typeof CatchContentEntry>;

/** `when` is the value the manifest schema declares as `type: boolean` — by the
 *  time the dispatcher sees it, that's either a literal boolean (`when: true`)
 *  or a CEL `CompiledValue` object (`when: ${{ ... }}`). Typing it as a string
 *  would reject both at the controller's `ctx.validateSchema` check; the
 *  dispatcher hands the value as-is to `expandWith`, which knows how to
 *  evaluate either shape. */
export const ReturnEntry = Type.Object({
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  when: Type.Optional(Type.Unknown()),
  mode: Type.Optional(Type.Union([Type.Literal("buffer"), Type.Literal("stream")])),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  content: Type.Optional(Type.Record(Type.String(), ContentEntry)),
});
export type ReturnEntry = Static<typeof ReturnEntry>;

export const CatchEntry = Type.Object({
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  when: Type.Optional(Type.Unknown()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  content: Type.Optional(Type.Record(Type.String(), CatchContentEntry)),
});
export type CatchEntry = Static<typeof CatchEntry>;
