/*
 * contract/index.ts — the one import path for the Accordion ↔ Conductor contract.
 *
 * Both halves of the contract live as siblings here: `conductor.ts` (the in-process
 * shape — `ConductorView`, the `Command` union, `ClampReport`, the `Conductor` interface)
 * and `protocol.ts` (the WebSocket messages, which import `Command`/`ClampReport`/`ViewBlock`
 * from `./conductor` so there is ONE definition). App code and out-of-process conductors
 * both import from `$conductors/contract`; this barrel keeps that a single path.
 */
export * from "./conductor";
export * from "./protocol";
