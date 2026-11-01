// An instance whose members share names with its declared fields: `label` holds
// a value of its own and `collection` is a method.
class SourceInstance {
  constructor() {
    this.label = "member label";
  }

  collection() {
    return { name: "member" };
  }

  invoke() {
    return "source";
  }
}

export const Source = {
  create() {
    return new SourceInstance();
  },
};

// Answers with the value it was configured with.
export const Echo = {
  create(resource) {
    return { invoke: () => resource.value };
  },
};
