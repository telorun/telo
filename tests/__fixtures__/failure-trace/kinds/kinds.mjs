// `Refuse` raises a coded failure; `Break` throws what a controller bug throws.
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

export const Break = {
  async create() {
    return {
      async invoke() {
        const row = undefined;
        return row.rows;
      },
    };
  },
};
