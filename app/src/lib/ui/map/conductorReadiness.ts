import type { ActiveConductorMeta } from "$core/protocol";

export function isConductorSelectable(conductor: ActiveConductorMeta): boolean {
	return conductor.readiness.state === "ready";
}

export function conductorReadinessText(conductor: ActiveConductorMeta): string | null {
	if (conductor.readiness.state === "ready") return null;
	return [conductor.readiness.reason, conductor.readiness.remediation].filter(Boolean).join(" ");
}
