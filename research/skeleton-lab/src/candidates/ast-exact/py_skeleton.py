#!/usr/bin/env python3
"""
py_skeleton.py — Python side of the "ast-exact" skeleton candidate.

Protocol: read one JSON object from stdin: {"source": str, "level": 1|2|3}.
Write one JSON object to stdout: {"skeleton": str}.

Never raises: any internal failure is caught and turned into a clearly-marked
"ast-exact failed" skeleton so the harness can still score something.
Deterministic: no timestamps, no absolute paths, no randomness; the caller is
expected to set PYTHONHASHSEED=0, though nothing here depends on hash-ordered
iteration of anything derived from source content.

Slicing strategy: every node is sliced from the ORIGINAL source text using
exact character offsets derived from (lineno, col_offset)/(end_lineno,
end_col_offset) — never whole-line copies — so a target/value/decorator that
shares a physical line with other code is extracted precisely, matching the
fidelity of the TypeScript side's getStart()/getEnd() node slicing.
"""

import ast
import json
import re
import sys

SMALL_INIT_MAX = 40
MAX_TRIM_ATTEMPTS = 50


# ---------------------------------------------------------------------------
# offset-precise source slicing
# ---------------------------------------------------------------------------

def _line_offsets(source):
    """offsets[i] = absolute char index of the start of 1-indexed line i+1."""
    offsets = [0]
    for line in source.split("\n")[:-1]:
        offsets.append(offsets[-1] + len(line) + 1)
    return offsets


class Src:
    """Bundles source text + its line-offset table for O(1) node slicing."""

    def __init__(self, source):
        self.text = source
        self.offsets = _line_offsets(source)

    def pos(self, lineno, col):
        if lineno < 1:
            lineno = 1
        if lineno > len(self.offsets):
            return len(self.text)
        return self.offsets[lineno - 1] + col

    def start_of(self, node):
        return self.pos(node.lineno, node.col_offset)

    def end_of(self, node):
        return self.pos(node.end_lineno, node.end_col_offset)

    def text_of(self, node):
        return self.text[self.start_of(node):self.end_of(node)]

    def between(self, a, b):
        """Text from end of node/pos `a` to start of node/pos `b`."""
        start = a if isinstance(a, int) else self.end_of(a)
        end = b if isinstance(b, int) else self.start_of(b)
        return self.text[start:end]

    def line_start(self, lineno):
        if lineno < 1 or lineno > len(self.offsets):
            return 0
        return self.offsets[lineno - 1]

    def indent_before_offset(self, lineno, offset):
        """Real leading whitespace of `lineno` up to `offset` — but if that
        span holds other (non-whitespace) code, e.g. an inline
        `class X: pass` one-liner, there is no indentation to reattach:
        return "" rather than duplicating that other code."""
        span = self.text[self.line_start(lineno):offset]
        return span if span.strip() == "" else ""

    def indent_before(self, node):
        """Real leading whitespace of the line node starts on (see
        indent_before_offset for the same-line-as-other-code guard)."""
        return self.indent_before_offset(node.lineno, self.start_of(node))

    def count_lines(self, a_pos, b_pos):
        if b_pos <= a_pos:
            return 0
        return self.text.count("\n", a_pos, b_pos) + 1


def _collapse(text):
    return " ".join(text.split())


def _is_dunder(name):
    return name.startswith("__") and name.endswith("__") and len(name) > 4


def _is_private(name):
    return name.startswith("_") and not _is_dunder(name)


def _is_func(stmt):
    return isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))


# ---------------------------------------------------------------------------
# parse with truncation recovery
# ---------------------------------------------------------------------------

def _parse_with_recovery(source):
    try:
        return ast.parse(source), source
    except SyntaxError:
        pass
    except (ValueError, RecursionError):
        pass
    lines = source.split("\n")
    n = len(lines)
    attempts = min(MAX_TRIM_ATTEMPTS, n)
    for k in range(1, attempts + 1):
        candidate = "\n".join(lines[: n - k])
        if not candidate.strip():
            break
        try:
            return ast.parse(candidate), candidate
        except SyntaxError:
            continue
        except (ValueError, RecursionError):
            continue
    return None, None


# ---------------------------------------------------------------------------
# shared building blocks
# ---------------------------------------------------------------------------

def _decorators_start(node, src):
    decs = getattr(node, "decorator_list", None)
    if decs:
        first = decs[0]
        # decorator node excludes the leading "@"; it always sits one column
        # before the expression on the same line.
        return src.pos(first.lineno, max(first.col_offset - 1, 0))
    return src.start_of(node)


def _docstring_stmt(node):
    body = getattr(node, "body", None)
    if not body:
        return None
    first = body[0]
    if (
        isinstance(first, ast.Expr)
        and isinstance(first.value, ast.Constant)
        and isinstance(first.value.value, str)
    ):
        return first
    return None


def _elide_value(value_node, src):
    text = src.text_of(value_node)
    if len(text) <= SMALL_INIT_MAX and "\n" not in text:
        return text
    n = src.count_lines(src.start_of(value_node), src.end_of(value_node))
    if isinstance(value_node, ast.Dict):
        return "{...}  # … %d lines" % n
    if isinstance(value_node, ast.List):
        return "[...]  # … %d lines" % n
    if isinstance(value_node, ast.Tuple):
        return "(...)  # … %d lines" % n
    if isinstance(value_node, ast.Set):
        return "{...}  # … %d lines" % n
    return "...  # … %d lines, %d chars" % (n, len(text))


def _target_text(target_nodes, src):
    return ", ".join(src.text_of(t) for t in target_nodes)


def _render_assign(stmt, src):
    target = _target_text(stmt.targets, src)
    val = _elide_value(stmt.value, src)
    return "%s = %s" % (target, val)


def _render_annassign(stmt, src):
    ann = src.text_of(stmt.annotation)
    target = src.text_of(stmt.target)
    if stmt.value is not None:
        val = _elide_value(stmt.value, src)
        return "%s: %s = %s" % (target, ann, val)
    return "%s: %s" % (target, ann)


_COMMENT_ONLY_LINE_RE = re.compile(r"^[ \t]*#")


def _strip_comment_only_lines(text):
    """Drop lines that are entirely a `#` comment (or blank). Used to clean
    the gap between a def/class's `:` and its first real statement — a gap
    ast doesn't model at all, so a comment sitting there (in place of a
    docstring) would otherwise leak into the header at every level. Safe to
    apply to the whole header block too: a genuine decorator/signature line
    always carries non-comment code, so it's never matched here."""
    lines = text.split("\n")
    kept = [ln for ln in lines if ln.strip() != "" and not _COMMENT_ONLY_LINE_RE.match(ln)]
    return "\n".join(kept)


def _signature_block(node, src, level=1):
    """Decorators + def/class header, verbatim multi-line text, up through
    (but excluding) wherever the body starts.

    col_offset skips leading whitespace, so the slice [start:end) is missing
    the real indentation of its own first line (every other line inside a
    multi-line span keeps its indentation, since that whitespace sits INSIDE
    the slice, not before it) — reattach it explicitly here.
    """
    start = _decorators_start(node, src)
    first_lineno = node.decorator_list[0].lineno if getattr(node, "decorator_list", None) else node.lineno
    indent = src.indent_before_offset(first_lineno, start)
    body = getattr(node, "body", None)
    end = src.start_of(body[0]) if body else src.end_of(node)
    text = indent + src.text[start:end]
    if level != 1:
        text = _strip_comment_only_lines(text)
    return text


def _render_def_or_class(node, lines_fn, src, level):
    """Shared renderer for FunctionDef/AsyncFunctionDef/ClassDef at L1/L2."""
    # Inline one-liner (`class X: pass`, `def f(): return 1`) — header and
    # body share a physical line, so there is nothing meaningful to split
    # off or elide; emit the whole thing verbatim rather than producing a
    # header that duplicates the inline body text.
    whole_start = _decorators_start(node, src)
    whole_first_lineno = node.decorator_list[0].lineno if getattr(node, "decorator_list", None) else node.lineno
    whole = src.indent_before_offset(whole_first_lineno, whole_start) + src.text[whole_start:src.end_of(node)]
    if "\n" not in whole and _docstring_stmt(node) is None:
        return whole

    pieces = [_signature_block(node, src, level).rstrip()]

    doc_stmt = _docstring_stmt(node)
    body = list(node.body)
    rest_start = src.start_of(body[0]) if body else src.end_of(node)
    if doc_stmt is not None:
        if level == 1:
            pieces.append(src.indent_before(doc_stmt) + src.text_of(doc_stmt))
        rest_start = src.end_of(doc_stmt)
        body = body[1:]

    if not body:
        return "\n".join(pieces)  # nothing elided: docstring (or nothing) was the whole body

    if lines_fn is None:
        # function/method: collapse remaining body to a single stub line
        end = src.end_of(node)
        n = src.count_lines(rest_start, end)
        indent = src.indent_before(body[0])
        pieces.append(indent + "...  # … %d lines" % n)
    else:
        for stmt in body:
            pieces.append(lines_fn(stmt, src, level))
    return "\n".join(pieces)


def _render_function(node, src, level):
    return _render_def_or_class(node, None, src, level)


def _render_class(node, src, level):
    return _render_def_or_class(node, _render_member, src, level)


def _render_member(stmt, src, level):
    if _is_func(stmt):
        return _render_function(stmt, src, level)
    if isinstance(stmt, ast.ClassDef):
        return _render_class(stmt, src, level)
    if isinstance(stmt, ast.Assign):
        indent = src.indent_before(stmt)
        return indent + _render_assign(stmt, src)
    if isinstance(stmt, ast.AnnAssign):
        indent = src.indent_before(stmt)
        return indent + _render_annassign(stmt, src)
    indent = src.indent_before(stmt)
    text = src.text_of(stmt)
    if len(text) <= 160 and "\n" not in text:
        return indent + text
    n = src.count_lines(src.start_of(stmt), src.end_of(stmt))
    return indent + "...  # … %d lines elided" % n


def _render_top_level(stmt, src, level):
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return src.text_of(stmt)
    if _is_func(stmt):
        return _render_function(stmt, src, level)
    if isinstance(stmt, ast.ClassDef):
        return _render_class(stmt, src, level)
    if isinstance(stmt, ast.Assign):
        return _render_assign(stmt, src)
    if isinstance(stmt, ast.AnnAssign):
        return _render_annassign(stmt, src)
    text = src.text_of(stmt)
    if len(text) <= 160 and "\n" not in text:
        return text
    n = src.count_lines(src.start_of(stmt), src.end_of(stmt))
    return "...  # … %d lines elided" % n


def render_l1_l2(tree, src, level):
    out = []
    module_doc = _docstring_stmt(tree)
    for i, stmt in enumerate(tree.body):
        if i == 0 and stmt is module_doc:
            if level == 1:
                out.append(src.indent_before(stmt) + src.text_of(stmt))
            continue
        out.append(_render_top_level(stmt, src, level))
    return "\n\n".join(p for p in out if p != "")


# ---------------------------------------------------------------------------
# L3 — API card
# ---------------------------------------------------------------------------

def _collapsed_signature(node, src):
    return _collapse(_signature_block(node, src, level=3)).rstrip(":") + ":"


def _render_class_l3(node, src):
    out = [_collapsed_signature(node, src) + " {"]
    private_count = 0
    module_doc = _docstring_stmt(node)
    for i, stmt in enumerate(node.body):
        if i == 0 and stmt is module_doc:
            continue
        if _is_func(stmt):
            if _is_private(stmt.name):
                private_count += 1
                continue
            out.append("  " + _collapsed_signature(stmt, src))
        elif isinstance(stmt, ast.ClassDef):
            if _is_private(stmt.name):
                private_count += 1
                continue
            nested = _render_class_l3(stmt, src)
            out.extend("  " + ln for ln in nested)
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            if names and all(_is_private(n) for n in names):
                private_count += 1
                continue
            target = _target_text(targets, src)
            if isinstance(stmt, ast.AnnAssign):
                out.append("  " + _collapse("%s: %s" % (target, src.text_of(stmt.annotation))))
            else:
                out.append("  " + _collapse("%s = …" % target))
        # other statement kinds inside a class body are dropped from the card
    if private_count:
        out.append("  // + %d private members" % private_count)
    out.append("}")
    return out


def render_l3(tree, src):
    import_mods = []
    out = []
    internal_count = 0
    module_doc = _docstring_stmt(tree)

    for i, stmt in enumerate(tree.body):
        if i == 0 and stmt is module_doc:
            continue
        if isinstance(stmt, ast.Import):
            import_mods.extend(alias.name for alias in stmt.names)
            continue
        if isinstance(stmt, ast.ImportFrom):
            import_mods.append(stmt.module or ("." * (stmt.level or 1)))
            continue
        if _is_func(stmt):
            if _is_private(stmt.name):
                internal_count += 1
                continue
            out.append(_collapsed_signature(stmt, src))
            continue
        if isinstance(stmt, ast.ClassDef):
            if _is_private(stmt.name):
                internal_count += 1
                continue
            out.extend(_render_class_l3(stmt, src))
            continue
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            if names and all(_is_private(n) for n in names):
                internal_count += 1
                continue
            target = _target_text(targets, src)
            if isinstance(stmt, ast.AnnAssign):
                out.append(_collapse("%s: %s" % (target, src.text_of(stmt.annotation))))
            else:
                out.append(_collapse("%s = …" % target))
            continue
        internal_count += 1

    header_out = []
    if import_mods:
        header_out.append("// imports: " + ", ".join(import_mods))
    header_out.extend(out)
    if internal_count:
        header_out.append("// + %d internal declarations" % internal_count)
    return "\n".join(header_out)


# ---------------------------------------------------------------------------
# entry points
# ---------------------------------------------------------------------------

def build_skeleton(source, level):
    tree, used_source = _parse_with_recovery(source)
    if tree is None:
        head = source[:400]
        return "/* ast-exact failed: python SyntaxError, no parseable prefix found */\n" + head

    truncated = used_source != source
    prefix_note = ""
    if truncated:
        used_lines = used_source.count("\n") + 1
        total_lines = source.count("\n") + 1
        prefix_note = (
            "# … ast-exact: input truncated/unparseable; showing first %d of %d lines\n"
            % (used_lines, total_lines)
        )

    try:
        src = Src(used_source)
        if level == 3:
            body = render_l3(tree, src)
        else:
            body = render_l1_l2(tree, src, level)
    except Exception as exc:  # never throw — degrade to an excerpt
        head = source[:400]
        return "/* ast-exact failed: %s */\n%s" % (type(exc).__name__ + ": " + str(exc), head)

    return prefix_note + body


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
        source = req.get("source", "")
        level = req.get("level", 1)
        if not isinstance(source, str):
            source = ""
        if level not in (1, 2, 3):
            level = 1
        skeleton = build_skeleton(source, level)
    except Exception as exc:
        skeleton = "/* ast-exact failed: %s */\n" % (type(exc).__name__ + ": " + str(exc))
    sys.stdout.write(json.dumps({"skeleton": skeleton}))


if __name__ == "__main__":
    main()
