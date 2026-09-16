import { describe, expect, it } from "vitest";
import { skeletonizeBlockContent, type ContentSkeletonizer } from "./content";

function engine(run: ContentSkeletonizer["skeletonize"]): ContentSkeletonizer {
	return { skeletonize: run };
}

describe("Triptych content-only code discovery", () => {
	it("skeletonizes a raw command Output payload without consulting its command or path", () => {
		const wrapper = [
			"Command: anything at all",
			"Chunk ID: abc123",
			"Wall time: 0.1 seconds",
			"Process exited with code 0",
			"Output:",
		].join("\n") + "\n";
		const source = "def alpha(value: int) -> int:\n    hidden = value * 2\n    return hidden\n";
		const seen: Array<{ source: string; hint?: string }> = [];
		const found = skeletonizeBlockContent(
			wrapper + source,
			engine((text, hint) => {
				seen.push({ source: text, hint });
				return { language: "python", skeleton: "def alpha(value: int) -> int:\n    ..." };
			}),
		);

		expect(seen).toEqual([{ source, hint: undefined }]);
		expect(found?.content.startsWith(wrapper)).toBe(true);
		expect(found?.content).toContain("[code skeleton — Python");
		expect(found?.content).toContain("def alpha(value: int) -> int:");
		expect(found?.content).not.toContain("hidden = value * 2");
	});

	it("skeletonizes fenced assistant code while preserving all surrounding prose and fences", () => {
		const source = "export function alpha(value: number): number {\n  const hidden = value * 2;\n  return hidden;\n}";
		const text = `Explanation before.\n\n\`\`\`ts\n${source}\n\`\`\`\n\nExplanation after.`;
		const found = skeletonizeBlockContent(
			text,
			engine((seen, hint) => {
				expect(seen).toBe(source);
				expect(hint).toBe("ts");
				return { language: "typescript", skeleton: "export function alpha(value: number): number { /* ... */ }" };
			}),
		);

		expect(found?.content).toContain("Explanation before.");
		expect(found?.content).toContain("Explanation after.");
		expect(found?.content).toContain("```ts\n[code skeleton — TypeScript");
		expect(found?.content).toContain("\n```\n");
		expect(found?.content).not.toContain("const hidden");
	});

	it("does not reinterpret prose around unsupported fenced content as raw source", () => {
		const text = "Use this:\n```bash\necho hello\n```\nThen continue.";
		const found = skeletonizeBlockContent(text, engine(() => null));
		expect(found).toBeNull();
	});

	it("declines a detector result that does not shrink its source span", () => {
		const source = "export interface Item { value: string; }";
		const found = skeletonizeBlockContent(
			source,
			engine((text) => ({ language: "typescript", skeleton: text })),
		);
		expect(found).toBeNull();
	});
});
