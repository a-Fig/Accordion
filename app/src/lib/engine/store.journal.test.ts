import { describe, expect, it } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import type { Command, Conductor, ConductorView } from "$conductors/contract";

function blk(i: number): Block {
	return {
		id: `m${i}:p0`,
		kind: "text",
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(160),
		tokens: 1000,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks: [blk(0), blk(1), blk(2)],
		lineCount: 0,
		skipped: 0,
	};
	const s = new AccordionStore(parsed);
	s.setProtect(0);
	return s;
}

class StubConductor implements Conductor {
	readonly id = "stub";
	readonly label = "Stub";
	cmds: Command[] = [];
	conduct(_view: ConductorView): Command[] {
		return this.cmds;
	}
}

describe("decision journal", () => {
	it("records manual transitions", () => {
		const s = makeStore();
		s.fold("m0:p0");
		s.unfold("m0:p0");

		expect(s.decisionJournal[0]).toMatchObject({ by: "you", action: "unfold", ids: ["m0:p0"] });
		expect(s.decisionJournal[1]).toMatchObject({ by: "you", action: "fold", ids: ["m0:p0"] });
	});

	it("records conductor transitions once and does not spam on identical refolds", () => {
		const s = makeStore();
		const stub = new StubConductor();
		stub.cmds = [{ kind: "fold", ids: ["m0:p0", "m1:p0"] }];

		s.attach(stub);
		const firstCount = s.decisionJournal.filter((e) => e.by === "auto" && e.action === "fold").length;
		expect(firstCount).toBe(2);
		const aggregateEntries = s.log.filter((e) => e.by === "auto" && e.action === "conductor update");
		expect(aggregateEntries).toHaveLength(1);
		expect(aggregateEntries[0].detail).toContain("folded 2 blocks");
		expect(s.log.some((e) => e.by === "auto" && e.action === "folded")).toBe(false);

		s.refold();
		const secondCount = s.decisionJournal.filter((e) => e.by === "auto" && e.action === "fold").length;
		expect(secondCount).toBe(2);
		expect(s.log.filter((e) => e.by === "auto" && e.action === "conductor update")).toHaveLength(1);
	});

	it("records conductor-created folded groups once without per-member fold inflation", () => {
		const s = makeStore();
		const stub = new StubConductor();
		stub.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"], digest: "group digest" }];

		s.attach(stub);

		const autoGroups = s.decisionJournal.filter((e) => e.by === "auto" && e.action === "group");
		const autoBlockFolds = s.decisionJournal.filter((e) => e.by === "auto" && e.action === "fold");
		expect(autoGroups).toHaveLength(1);
		expect(autoGroups[0].ids).toEqual(["g:m0:p0"]);
		expect(autoBlockFolds).toHaveLength(0);
		const aggregateEntries = s.log.filter((e) => e.by === "auto" && e.action === "conductor update");
		expect(aggregateEntries).toHaveLength(1);
		expect(aggregateEntries[0].detail).toContain("grouped 1 group");
	});

	it("records group tile fold and unfold with distinct journal actions", () => {
		const s = makeStore();
		const g = s.createGroup("m0:p0", "m1:p0");
		expect(g).toBeTruthy();

		s.unfoldGroup(g!.id);
		s.foldGroup(g!.id);

		expect(s.decisionJournal[0]).toMatchObject({ by: "you", action: "fold-group", ids: [g!.id, ...g!.memberIds] });
		expect(s.decisionJournal[1]).toMatchObject({ by: "you", action: "unfold-group", ids: [g!.id, ...g!.memberIds] });
		expect(s.decisionJournal[2]).toMatchObject({ by: "you", action: "group", ids: [g!.id, ...g!.memberIds] });
	});
});
