/*
 * string-hell.ts — synthetic adversarial fixture for skeleton-lab.
 *
 * Purpose: stress-test skeleton extractors against string/template literals
 * whose CONTENTS look like code (braces, quotes, nested ${}) but must never be
 * parsed as structure. A naive brace-counting skeletonizer will miscount here;
 * a real parser (ts.createSourceFile) will not.
 */

export interface QuerySpec {
	table: string;
	where?: Record<string, string | number>;
}

/** Builds a fake SQL string. The body is one big template literal full of
 * braces, quotes, and nested `${...}` — none of it is real TS structure. */
export function buildQuery(spec: QuerySpec): string {
	const clauses = Object.entries(spec.where ?? {}).map(
		([k, v]) => `${k} = ${typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : v}`,
	);
	const sql = `SELECT * FROM "${spec.table}" ${
		clauses.length ? `WHERE ${clauses.join(" AND ")} ` : ""
	}-- generated { "not": "json", "nested": { "a": [1,2,3] } }`;
	return sql;
}

/** A constant whose value is a JSON-looking string with escaped quotes and
 * curly braces that do NOT correspond to any TS block. */
export const FAKE_JSON_BLOB =
	'{"kind":"fold","ids":["a","b"],"note":"contains \\"escaped\\" quotes and a } stray brace"}';

/** Template literal containing a fragment of markup with `${}`-looking text
 * that is plain string content, plus a REAL nested `${...}` interpolation. */
export function renderBanner(name: string, level: number): string {
	const bar = "=".repeat(Math.max(0, level));
	return `<div data-name="${name}">
  literal text with fake interpolation \${notReallyInterpolated}
  and a real one: ${bar}
  and braces: { not: "an object literal", just: "text" }
</div>`;
}

/** Deeply nested template expressions: \`${ \`${ \`${ x }\` }\` }\`. */
export function nestDeep(x: string): string {
	const one = `${x}`;
	const two = `${`${one}`}`;
	const three = `${`${`${two}`}`}`;
	return `outer(${three}) // trailing comment-looking text: /* not a comment */`;
}

/** A class whose only job is to hold string constants that look like code. */
export class TemplateBook {
	static readonly SNIPPETS: Record<string, string> = {
		bash: `if [ "$x" = '{"a":1}' ]; then echo "brace in a string: {}"; fi`,
		regex: "const re = /\\{.*?\\}/g; // looks like a function but is a string",
		nested: `outer { middle "${"inner ${literal} text"}" middle } outer`,
	};

	describe(key: string): string {
		return this.SNIPPETS[key] ?? `no snippet for "${key}"`;
	}
}

/** Exported type alias whose literal members are punctuation-heavy strings. */
export type WeirdToken = "{" | "}" | "${" | "`" | "'\"'" | "\\`${}\\`";

export function classify(tok: WeirdToken): string {
	switch (tok) {
		case "{":
			return "open-brace-string";
		case "}":
			return "close-brace-string";
		case "${":
			return "dollar-brace-string";
		default:
			return `other: ${tok}`;
	}
}
