import * as React from "react";

export type Loaded<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "ready"; data: T; error?: undefined }
  | { status: "failed"; data?: undefined; error: unknown };

/** Runs `load` whenever `deps` change; `reload` runs it again keeping the last
 *  data on screen until the new answer lands. */
export function useLoad<T>(load: () => Promise<T>, deps: React.DependencyList): [Loaded<T>, () => void] {
  const [state, setState] = React.useState<Loaded<T>>({ status: "loading" });
  const [generation, setGeneration] = React.useState(0);
  const run = React.useCallback(load, deps);

  React.useEffect(() => {
    let current = true;
    run().then(
      (data) => current && setState({ status: "ready", data }),
      (error: unknown) => current && setState({ status: "failed", error }),
    );
    return () => {
      current = false;
    };
  }, [run, generation]);

  const reload = React.useCallback(() => setGeneration((g) => g + 1), []);
  return [state, reload];
}
