import { useCallback, useSyncExternalStore } from "react";
import type { ViewModelStatus, ViewModelStore } from "../language/view-model-store";

/** The view model of the module at `modulePath`, read for as long as the
 *  calling component is mounted; `undefined` with no store or no module. */
export function useViewModel(
  store: ViewModelStore | null,
  modulePath: string | null | undefined,
): ViewModelStatus | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!store || !modulePath) return () => undefined;
      const subscription = store.subscribe(modulePath, onChange);
      return () => subscription.dispose();
    },
    [store, modulePath],
  );
  const snapshot = useCallback(
    () => (store && modulePath ? store.get(modulePath) : undefined),
    [store, modulePath],
  );
  return useSyncExternalStore(subscribe, snapshot);
}
