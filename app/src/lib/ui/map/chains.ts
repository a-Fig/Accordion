import type { Block } from "../../engine/types";
import { messageKey } from "../../engine/ids";

/**
 * Coarser "chains" zoom units for the map: user prompts stand alone; assistant
 * message parts stay together; following tool results attach to the current chain.
 */
export function chainsOf(blocks: Block[]): Block[][] {
	const out: Block[][] = [];
	let cur: Block[] | null = null;
	let curMsg: string | null = null;
	for (const b of blocks) {
		const msg = messageKey(b.id);
		if (b.kind === "user") {
			if (cur) out.push(cur);
			out.push([b]);
			cur = null;
			curMsg = null;
			continue;
		}
		if (b.kind !== "tool_result") {
			if (cur && msg !== curMsg) {
				out.push(cur);
				cur = null;
			}
			if (!cur) cur = [];
			curMsg = msg;
			cur.push(b);
		} else {
			if (!cur) {
				cur = [];
				curMsg = null;
			}
			cur.push(b);
		}
	}
	if (cur) out.push(cur);
	return out;
}
