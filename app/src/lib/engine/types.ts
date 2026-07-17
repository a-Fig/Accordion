// Moved to the framework-free core package. Re-export shim: keeps `../engine/types`
// imports (app + extension) working unchanged. Source of truth: core/types.ts.
export type * from "../../../../core/types";
