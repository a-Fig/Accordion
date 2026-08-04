import { describe, expect, it } from "vitest";
import type { ActiveConductorMeta } from "$core/protocol";
import { conductorReadinessText, isConductorSelectable } from "./conductorReadiness";

function meta(readiness: ActiveConductorMeta["readiness"]): ActiveConductorMeta {
	return {
		id: "triptych",
		label: "Triptych",
		locks: ["human-steering", "agent-unfold"],
		tailTokens: 0,
		holdWireUpToMs: 0,
		remote: true,
		readiness,
	};
}

describe("conductor readiness presentation", () => {
	it("allows ready conductors", () => {
		const conductor = meta({ state: "ready" });
		expect(isConductorSelectable(conductor)).toBe(true);
		expect(conductorReadinessText(conductor)).toBeNull();
	});

	it("blocks unavailable conductors and combines reason with remediation", () => {
		const conductor = meta({
			state: "unavailable",
			reason: "Tree-sitter dependencies are missing.",
			remediation: "Run npm install.",
		});
		expect(isConductorSelectable(conductor)).toBe(false);
		expect(conductorReadinessText(conductor)).toBe("Tree-sitter dependencies are missing. Run npm install.");
	});
});
