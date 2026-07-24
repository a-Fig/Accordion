/*
 * skeletonize.test.ts — a pinning subset of the deleted `app/src/lib/engine/skeletonize.test.ts`
 * (ADR 0016, git rev dc037bc), ported to lock down that the VERBATIM port in `skeletonize.ts`
 * still behaves exactly like the original: a TS file and a Python file each keep their
 * interface (imports/signatures/docstrings) while eliding bodies, shrink, and are byte-
 * deterministic. Not exhaustive — see the original for full per-language coverage (svelte,
 * css, rust, generic); this file exists to pin the port, not re-litigate the design.
 */
import { describe, it, expect } from "vitest";
import { skeletonize, detectLang, type Lang } from "./skeletonize";

// ----------------------------------------------------------------------------------------
// detectLang — a handful of extension + content-sniff cases
// ----------------------------------------------------------------------------------------

describe("detectLang", () => {
	it("picks the language from a known extension", () => {
		expect(detectLang("src/foo.ts", "")).toBe("ts");
		expect(detectLang("script.py", "")).toBe("python");
		expect(detectLang("main.rs", "")).toBe("rust");
	});
	it("is case-insensitive on the extension", () => {
		expect(detectLang("FOO.TS", "")).toBe("ts");
		expect(detectLang("FOO.Py", "")).toBe("python");
	});
	it("falls through to a content sniff when the extension is unknown", () => {
		expect(detectLang("notes.txt", "const x = 1;\nfunction y() {}")).toBe("ts");
		expect(detectLang(undefined, "def add(a, b):\n    return a + b\n")).toBe("python");
	});
	it("never throws on empty/weird input", () => {
		expect(detectLang(undefined, "")).toBe("generic");
		expect(detectLang("", "")).toBe("generic");
	});
});

// ----------------------------------------------------------------------------------------
// Shared assertion helpers (ported from the reference test file)
// ----------------------------------------------------------------------------------------

function assertSmaller(src: string, lang: Lang) {
	const r = skeletonize(src, lang);
	expect(r.skeleton.length).toBeLessThan(src.length);
	expect(r.elidedLines).toBeGreaterThan(0);
	expect(r.totalLines).toBe(src.split("\n").length);
	return r;
}

function assertDeterministic(src: string, lang: Lang) {
	const a = skeletonize(src, lang);
	const b = skeletonize(src, lang);
	expect(a.skeleton).toBe(b.skeleton);
	expect(a).toEqual(b);
}

// ----------------------------------------------------------------------------------------
// TypeScript
// ----------------------------------------------------------------------------------------

const TS_SAMPLE = `import { readFile } from "node:fs/promises";
import type { Config } from "./config";

export const VERSION = "1.2.3";

/** A widget the loader builds. */
export interface Widget {
  id: string;
  label: string;
  render(): string;
}

export type Mode = "fast" | "slow";

@sealed
export class Loader extends Base implements Runnable {
  private cache: Map<string, Widget> = new Map();

  constructor(private cfg: Config) {
    super();
    const seedLocal = cfg.seed ?? 0;
    this.cache.set("seed", makeWidget(seedLocal));
  }

  async load(path: string): Promise<Widget> {
    const rawText = await readFile(path, "utf8");
    const parsedThing = JSON.parse(rawText);
    return makeWidget(parsedThing.id);
  }

  get size(): number {
    return this.cache.size;
  }
}

export function makeWidget(id: string): Widget {
  const builtWidget = { id, label: id.toUpperCase(), render: () => id };
  return builtWidget;
}
`;

describe("skeletonize ts", () => {
	const r = skeletonize(TS_SAMPLE, "ts");

	it("preserves contract: imports, exports, type/interface/class/function names", () => {
		for (const tok of [
			"import",
			'from "node:fs/promises"',
			"import type { Config }",
			"export const VERSION",
			"interface Widget",
			"render(): string",
			"export type Mode",
			"class Loader extends Base implements Runnable",
			"constructor",
			"async load",
			"get size",
			"export function makeWidget",
			"@sealed",
		]) {
			expect(r.skeleton).toContain(tok);
		}
	});

	it("keeps the leading JSDoc comment on the interface", () => {
		expect(r.skeleton).toContain("A widget the loader builds.");
	});

	it("elides function/method BODY locals", () => {
		for (const local of ["seedLocal", "rawText", "parsedThing", "builtWidget", "JSON.parse"]) {
			expect(r.skeleton).not.toContain(local);
		}
	});

	it("smaller + elides + accurate totalLines", () => {
		assertSmaller(TS_SAMPLE, "ts");
	});

	it("deterministic", () => {
		assertDeterministic(TS_SAMPLE, "ts");
	});
});

// ----------------------------------------------------------------------------------------
// Python
// ----------------------------------------------------------------------------------------

const PY_SAMPLE = `#!/usr/bin/env python3
"""Module docstring describing the file."""
import os
from typing import Optional

API_ROOT = "https://example.test"


def fetch(url: str, retries: int = 3) -> Optional[str]:
    """Fetch a URL with retries."""
    attemptCounter = 0
    while attemptCounter < retries:
        attemptCounter += 1
    return None


class Client:
    """A small HTTP client."""

    def __init__(self, token: str) -> None:
        self.token = token
        secretHeader = {"Authorization": token}
        self._headers = secretHeader

    async def get(
        self,
        path: str,
    ) -> dict:
        composedUrl = API_ROOT + path
        return {"url": composedUrl}


if __name__ == "__main__":
    fetch(API_ROOT)
`;

describe("skeletonize python", () => {
	const r = skeletonize(PY_SAMPLE, "python");

	it("preserves contract: imports, constants, class + def signatures, docstrings", () => {
		for (const tok of [
			"import os",
			"from typing import Optional",
			"API_ROOT =",
			"Module docstring describing the file.",
			"def fetch(url: str, retries: int = 3) -> Optional[str]:",
			"Fetch a URL with retries.",
			"class Client:",
			"A small HTTP client.",
			"def __init__(self, token: str) -> None:",
			"async def get(",
			'if __name__ == "__main__":',
		]) {
			expect(r.skeleton).toContain(tok);
		}
	});

	it("elides def body locals", () => {
		for (const local of ["attemptCounter", "secretHeader", "composedUrl"]) {
			expect(r.skeleton).not.toContain(local);
		}
	});

	it("uses a python `...` stub for elided bodies", () => {
		expect(r.skeleton).toContain("...");
	});

	it("smaller + elides", () => {
		assertSmaller(PY_SAMPLE, "python");
	});

	it("deterministic", () => {
		assertDeterministic(PY_SAMPLE, "python");
	});
});

// ----------------------------------------------------------------------------------------
// Determinism smoke (doorman spec item 7): same input, twice, byte-identical.
// ----------------------------------------------------------------------------------------

describe("skeletonize — determinism smoke", () => {
	it("ts: two calls on the same source produce byte-identical output", () => {
		const a = skeletonize(TS_SAMPLE, "ts");
		const b = skeletonize(TS_SAMPLE, "ts");
		expect(a.skeleton).toBe(b.skeleton);
		expect(a).toEqual(b);
	});
	it("python: two calls on the same source produce byte-identical output", () => {
		const a = skeletonize(PY_SAMPLE, "python");
		const b = skeletonize(PY_SAMPLE, "python");
		expect(a.skeleton).toBe(b.skeleton);
		expect(a).toEqual(b);
	});
});
