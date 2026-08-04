/*
 * content.ts — content-only code discovery for Triptych.
 *
 * Triptych deliberately does not trust tool names, call arguments, file paths, or extensions.
 * It sees the same block text the model sees and asks the injected tree-sitter engine whether
 * that text contains TypeScript/JavaScript/Python worth skeletonizing. Markdown code fences are
 * handled span-by-span; raw command output keeps its visible wrapper while only the Output payload
 * is replaced. Everything outside a detected code span is preserved byte-for-byte.
 */

export type CodeLanguage = "typescript" | "javascript" | "python";

export interface SkeletonMatch {
	language: CodeLanguage;
	skeleton: string;
}

export interface ContentSkeletonizer {
	/** Content-only detection. `hint` comes from an in-context Markdown fence, never a file path. */
	skeletonize(source: string, hint?: string): SkeletonMatch | null;
}

export interface ContentSkeleton {
	content: string;
	spans: number;
	languages: CodeLanguage[];
}

const FENCE_RE = /```([^\r\n`]*)\r?\n([\s\S]*?)(\r?\n)```/g;

/** Preserve visible execution framing and parse only what follows its explicit Output marker. */
function payloadStart(text: string): number {
	const marker = /\r?\nOutput:\r?\n/;
	const found = marker.exec(text);
	if (found === null) return 0;
	const at = found.index;
	const prefix = text.slice(0, at);
	if (!/^Command:/m.test(prefix)) return 0;
	if (!/^(?:Chunk ID|Wall time|Process exited|Original token count):/m.test(prefix)) return 0;
	return at + found[0].length;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let n = 1;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

function languageLabel(language: CodeLanguage): string {
	if (language === "typescript") return "TypeScript";
	if (language === "javascript") return "JavaScript";
	return "Python";
}

function header(language: CodeLanguage, lines: number): string {
	return `[code skeleton — ${languageLabel(language)} signatures kept, bodies elided (${lines} source lines). Use recall with the fold code above for the full block.]`;
}

/** Discover supported code spans in one context block and preserve all non-code text verbatim. */
export function skeletonizeBlockContent(text: string, engine: ContentSkeletonizer): ContentSkeleton | null {
	if (text.length === 0) return null;
	const start = payloadStart(text);
	const prefix = text.slice(0, start);
	const payload = text.slice(start);

	let cursor = 0;
	let changed = false;
	let spans = 0;
	const languages = new Set<CodeLanguage>();
	const parts: string[] = [];
	FENCE_RE.lastIndex = 0;
	for (let match = FENCE_RE.exec(payload); match !== null; match = FENCE_RE.exec(payload)) {
		const whole = match[0];
		const info = match[1].trim().split(/\s+/, 1)[0] || undefined;
		const source = match[2];
		const bodyAt = whole.indexOf(source);
		const result = engine.skeletonize(source, info);
		parts.push(payload.slice(cursor, match.index));
		if (result !== null && result.skeleton.length < source.length) {
			parts.push(
				whole.slice(0, bodyAt),
				`${header(result.language, countLines(source))}\n${result.skeleton}`,
				whole.slice(bodyAt + source.length),
			);
			changed = true;
			spans++;
			languages.add(result.language);
		} else {
			parts.push(whole);
		}
		cursor = match.index + whole.length;
	}

	// A block with fences is mixed content. Only its explicit code spans are candidates.
	if (cursor > 0) {
		parts.push(payload.slice(cursor));
		return changed ? { content: prefix + parts.join(""), spans, languages: [...languages] } : null;
	}

	const result = engine.skeletonize(payload);
	if (result === null || result.skeleton.length >= payload.length) return null;
	return {
		content: `${prefix}${header(result.language, countLines(payload))}\n${result.skeleton}`,
		spans: 1,
		languages: [result.language],
	};
}
