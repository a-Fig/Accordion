// In-memory opt-in switch: when enabled, the GUI's fold plan is actually applied to
// the live agent's context. OFF by default AND reset on every new live attach (see
// liveClient's `hello` handler), so arming is a deliberate, per-session action —
// folding a real model call is never silently carried from one agent to the next
// (adversarial review Q5). Intentionally NOT persisted: the safe state (off) is
// always the starting state for a fresh attach.
export const folding = $state<{ enabled: boolean }>({ enabled: false });

export function setFolding(on: boolean): void {
	folding.enabled = on;
}
