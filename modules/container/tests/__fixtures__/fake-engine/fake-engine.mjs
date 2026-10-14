export const Engine = {
  async create() {
    const ports = new Map();
    return {
      async ping() {},
      async hasImage() {
        return true;
      },
      async pullImage() {},
      async create(spec) {
        const id = `fake-${ports.size + 1}`;
        ports.set(id, spec.ports);
        return id;
      },
      async start() {},
      async inspect(id) {
        const bindings = new Map((ports.get(id) ?? []).map((port) => [port, { host: "127.0.0.1", port }]));
        return { running: true, exitCode: null, bindings };
      },
      async *logs() {},
      async list() {
        return [];
      },
      async remove(id) {
        ports.delete(id);
      },
    };
  },
};
