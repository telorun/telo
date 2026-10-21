// Controllers for the text-record tests. Each records what it received on a
// process-wide probe the test reads.
const probe = (globalThis.__textRecordProbe ??= { labels: {}, peers: {}, calls: [] });

export const Label = {
  create(resource) {
    probe.labels[resource.metadata.name] = resource.text;
    return {
      init() {
        if (resource.peer !== undefined) {
          probe.peers[resource.metadata.name] = typeof resource.peer.snapshot === "function";
        }
      },
      snapshot() {
        return {};
      },
    };
  },
};

export const Translate = {
  create() {
    return {
      call: ({ text }) => {
        probe.calls.push(text);
        return "translated";
      },
    };
  },
};

export const Show = {
  create() {
    return { snapshot: () => ({}) };
  },
};
