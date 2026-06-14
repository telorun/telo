// Importing this module throws. The app declares no resource of the kind it
// backs, so lazy controller loading must never import it — if it did, boot
// would crash here. Eager loading (pre-change) imported every definition's
// controller at init and would fail on this module.
throw new Error("boom.mjs was imported — lazy loading must not import an uninstantiated controller");

export const boom = {};
