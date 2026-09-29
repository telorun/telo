// Each probe keeps the target it was created with, as the kernel handed it over.
export const Received = {
  async create(resource) {
    return { received: resource.target, invoke: async () => resource.target };
  },
};

export const ReceivedInner = {
  async create(resource) {
    return { received: resource.inner.target, invoke: async () => resource.inner.target };
  },
};
