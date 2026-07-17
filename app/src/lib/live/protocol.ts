/*
 * protocol.ts — re-export shim. The live-link wire contract moved to the framework-free
 * core package (core/protocol.ts) in Phase B so the extension (authoritative Truth host) and
 * the app (replica client) import ONE definition. Keep this shim so `./protocol` / `$lib/live/protocol`
 * imports across the app keep working. Source of truth: core/protocol.ts.
 */
export * from "$core/protocol";
