import { InvokeError } from "@telorun/sdk";

export const Refuse = {
  async create() {
    return {
      async invoke() {
        throw new InvokeError("ERR_USER_EXISTS", "a user with this email already exists");
      },
    };
  },
};
