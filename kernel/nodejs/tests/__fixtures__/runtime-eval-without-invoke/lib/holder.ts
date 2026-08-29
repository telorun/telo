/** A provider with no invoke(): provide() is parameterless, so a runtime-eval
 *  field on this kind has no call whose inputs it could be expanded against. */
export const create = () => ({
  provide: async () => ({ ok: true }),
  snapshot: () => ({}),
});
