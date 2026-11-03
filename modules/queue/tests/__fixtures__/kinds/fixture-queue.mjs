// Never loaded: the fixture kinds exist for `telo check` only.
const refuse = () => {
  throw new Error("The queue fixture kinds are for static checks and have no runtime.");
};
export const PlainQueue = { create: refuse };
export const KeyedQueue = { create: refuse };
