// Joins a key and a message.
export const Hmac = {
  create() {
    return { call: ({ key, message }) => `${key}:${message}` };
  },
};
