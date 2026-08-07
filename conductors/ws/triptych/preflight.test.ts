import { describe, expect, it, vi } from "vitest";
// The production runner is native ESM; Vitest can load it directly even though it has no TS types.
// @ts-expect-error JavaScript helper intentionally ships without a declaration file.
import { initializeSkeletonizer } from "./preflight.mjs";

describe("Triptych runner preflight", () => {
	it("accepts an engine only after initialization reports ready", async () => {
		let ready = false;
		const init = vi.fn(async () => {
			ready = true;
		});

		await expect(initializeSkeletonizer({ init, ready: () => ready })).resolves.toBeUndefined();
		expect(init).toHaveBeenCalledOnce();
	});

	it("propagates grammar/WASM initialization failures before connection", async () => {
		const failure = new Error("cannot load tree-sitter-python.wasm");
		await expect(
			initializeSkeletonizer({ init: () => Promise.reject(failure), ready: () => false }),
		).rejects.toThrow(failure.message);
	});

	it("rejects an engine that resolves init without becoming ready", async () => {
		await expect(
			initializeSkeletonizer({ init: () => Promise.resolve(), ready: () => false }),
		).rejects.toThrow(/without becoming ready/);
	});
});
