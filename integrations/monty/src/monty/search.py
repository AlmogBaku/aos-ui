"""Use lexical discovery for small catalogs and upstream hybrid search for large ones."""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower().replace("_", " ")))


class ToolSearchIndex:
    def __init__(self, entries: list[dict[str, str]], semantic: Any = None):
        self.entries = entries
        self._semantic = semantic

    @classmethod
    async def create(
        cls, entries: list[dict[str, str]], *, embedding_threshold: int = 30, embedder: Any = None
    ) -> ToolSearchIndex:
        if embedding_threshold < 0:
            raise ValueError("embedding_threshold must be non-negative")
        semantic = None
        if len(entries) > embedding_threshold:
            from monty.semantic import ToolSearchIndex as SemanticIndex

            try:
                semantic = await SemanticIndex.create(entries, embedder=embedder)
            except ImportError as exc:
                raise RuntimeError(
                    "This catalog needs semantic search. Install it with "
                    "'uv sync --project integrations/monty --extra semantic --frozen', "
                    "then run with '--extra semantic' before 'python -m monty'."
                ) from exc
        return cls(entries, semantic)

    @property
    def uses_embeddings(self) -> bool:
        return self._semantic is not None

    def search(self, query: str, limit: int = 10) -> list[dict[str, str]]:
        if limit <= 0:
            return []
        if self._semantic is not None:
            return self._semantic.search(query, limit)

        query_tokens = _tokens(query)

        def score(entry: dict[str, str]) -> tuple[float, str]:
            name = entry["name"].replace("_", " ")
            haystack = f"{name} {entry['description']}".lower()
            overlap = len(query_tokens & _tokens(haystack))
            substring = 2 if query.lower().strip() in haystack else 0
            fuzzy = max(SequenceMatcher(None, token, name).ratio() for token in query_tokens or {""})
            return -(overlap * 4 + substring + fuzzy), entry["name"]

        return sorted(self.entries, key=score)[:limit]

    def close(self) -> None:
        if self._semantic is not None:
            self._semantic.close()
