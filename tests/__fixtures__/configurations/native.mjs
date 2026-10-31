// A native function: whether the environment it is given is production.
export const Native = {
  create() {
    return { call: ({ env }) => env === "prod" };
  },
};
