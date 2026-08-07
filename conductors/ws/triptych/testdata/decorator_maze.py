"""decorator_maze.py — synthetic adversarial fixture for skeleton-lab.

Stress-tests ground-truth extraction against heavy decorator stacks, nested
classes, async defs, and triple-quoted strings whose CONTENTS look like real
Python definitions (to trip up any regex-based extractor). A real `ast`-based
walker must ignore the text below and only report the actual module symbols.

Fake code embedded in a docstring, for confusion purposes only — none of this
should show up in the extracted symbol list:

    def fake():
        class NotReal:
            def also_fake(self):
                pass
    async def fake_async():
        return 1
"""

from __future__ import annotations

import functools
import contextlib
from dataclasses import dataclass, field
from typing import Any, Callable


def trace(label: str) -> Callable:
    """Decorator factory: logs entry/exit under `label`."""

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def retry(times: int = 3):
    """Another decorator factory, stacked with @trace below in some spots."""

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            last_exc = None
            for _ in range(times):
                try:
                    return fn(*a, **kw)
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
            raise last_exc

        return wrapper

    return decorator


@dataclass
class Config:
    """Holds a triple-quoted default full of fake defs, to further confuse
    naive extractors:

    '''
    def another_fake(): ...
    class AlsoNotReal: pass
    '''
    """

    name: str
    retries: int = 3
    tags: list[str] = field(default_factory=list)


class Outer:
    """Outer class with a nested class and decorated methods."""

    class Inner:
        """Nested class — its methods should be reported as Inner.method,
        not Outer.method."""

        @trace("inner.run")
        def run(self, x: int) -> int:
            return x * 2

        @staticmethod
        def make() -> "Outer.Inner":
            return Outer.Inner()

        class DeepestInner:
            """A second level of nesting."""

            @property
            def value(self) -> int:
                return 42

    @trace("outer.compute")
    @retry(times=2)
    def compute(self, a: int, b: int) -> int:
        return a + b

    @classmethod
    def from_config(cls, cfg: Config) -> "Outer":
        return cls()

    @contextlib.contextmanager
    def session(self):
        yield self

    async def fetch(self, url: str) -> str:
        """Real async method — must be reported, unlike the fake one in the
        module docstring above."""
        return url

    @staticmethod
    async def fetch_many(urls: list[str]) -> list[str]:
        results = []
        for u in urls:
            results.append(u)
        return results


@trace("module.level")
async def top_level_async(n: int) -> int:
    """A real module-level async function decorated twice-removed."""
    return n


def make_closure():
    """Returns a closure whose inner function is NOT a module-level symbol."""

    def inner(x):
        return x + 1

    return inner


MODULE_CONSTANT: dict[str, str] = {
    "note": "this value is data, not a definition",
}

__all__ = ["Config", "Outer", "top_level_async", "trace", "retry"]
