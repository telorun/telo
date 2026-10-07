import Package from "react-dom";

// The DOM half of the page's one React, under `react-dom`. Every name is listed: the package is CommonJS, so
// nothing but an explicit list gives the built module named exports.
const namespace = Package as unknown as Record<string, any>;

export default Package;
export const {
  __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormState,
  useFormStatus,
  version,
} = namespace;
