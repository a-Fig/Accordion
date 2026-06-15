/*
 * conductors/index.ts — the in-process conductor registry.
 *
 * Every conductor — built-in included — now lives under this directory and imports the
 * contract as a sibling (`./contract`), never from the app. The app compiles in-process
 * conductors and reaches them through this barrel via the `$conductors` alias; external
 * conductors attach over the wire (see `live/conductorClient.svelte.ts`).
 *
 * The built-in is no longer special-cased anywhere — it is simply the first entry in
 * `IN_PROCESS_CONDUCTORS`. Adding another in-process conductor is one line here, and it
 * shows up in the switcher and is selectable automatically.
 */
import { BuiltinConductor } from "./builtin/builtin";
import { ColdScoreConductor } from "./cold-score/cold-score";
import { ColdEpochConductor } from "./cold-epoch/cold-epoch";
import type { Conductor } from "./contract";

export { BuiltinConductor } from "./builtin/builtin";
export { ColdScoreConductor } from "./cold-score/cold-score";
export { ColdEpochConductor } from "./cold-epoch/cold-epoch";

/** A conductor compiled into the app (in-process). */
export interface InProcessConductor {
  id: string;
  label: string;
  create: () => Conductor;
}

/** In-process conductors that ship in the app, listed in the switcher.
 *  Add a new in-process conductor here — one line — and it appears automatically. */
export const IN_PROCESS_CONDUCTORS: InProcessConductor[] = [
  { id: "builtin", label: "Built-in", create: () => new BuiltinConductor() },
  { id: "cold-score", label: "Cold-score", create: () => new ColdScoreConductor() },
  { id: "cold-epoch", label: "Cold epoch", create: () => new ColdEpochConductor() },
];

/** Look up an in-process conductor by id (null if not one). */
export function inProcessConductor(id: string): InProcessConductor | null {
  return IN_PROCESS_CONDUCTORS.find((c) => c.id === id) ?? null;
}
