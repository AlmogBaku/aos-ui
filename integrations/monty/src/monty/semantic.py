"""Hybrid search index for MCP tools (full-text + semantic vector search)."""

from __future__ import annotations

import asyncio
import tempfile
from typing import Protocol, cast, runtime_checkable


@runtime_checkable
class Embedder(Protocol):
    """Protocol for text embedding backends. Swap implementations freely."""

    def encode(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text."""
        ...


class SentenceTransformerEmbedder:
    """Local sentence-transformers embedder — no API key required.

    Uses all-MiniLM-L6-v2 (~90 MB, downloaded once to ~/.cache).
    To swap models, change MODEL or subclass.
    """

    MODEL = "all-MiniLM-L6-v2"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(self.MODEL)

    def encode(self, texts: list[str]) -> list[list[float]]:
        return cast(list[list[float]], self._model.encode(texts, show_progress_bar=False).tolist())


class ToolSearchIndex:
    """In-memory hybrid search index (full-text + semantic) over MCP tools.

    Hybrid strategy: FTS results appear first (exact keyword matches), then
    vector similarity fills remaining slots up to `limit`. This ensures that
    precise name matches always surface while semantic neighbours fill the rest.
    """

    def __init__(self, table, embedder: Embedder) -> None:
        self._table = table
        self._embedder = embedder

    @classmethod
    async def create(
        cls,
        tools: list[dict[str, str]],
        embedder: Embedder | None = None,
    ) -> "ToolSearchIndex":
        """Build the index from a list of MCP tools.

        Loads the embedding model on first call (slow; subsequent calls reuse).
        Pass a custom ``embedder`` to override the default SentenceTransformerEmbedder.
        """
        import lancedb

        if embedder is None:
            embedder = await asyncio.to_thread(SentenceTransformerEmbedder)

        texts = [f"{t['name']} {t['description']}".strip() for t in tools]
        vectors = await asyncio.to_thread(embedder.encode, texts) if texts else []

        records = [
            {
                **t,
                "text": texts[i],
                "vector": vectors[i],
            }
            for i, t in enumerate(tools)
        ]

        if not records:
            return cls(None, embedder)  # type: ignore[arg-type]

        tmpdir = tempfile.TemporaryDirectory(prefix="monty_search_")
        db = await asyncio.to_thread(lancedb.connect, tmpdir.name)
        table = await asyncio.to_thread(db.create_table, "tools", records)
        try:
            await asyncio.to_thread(table.create_fts_index, "text")
        except Exception:
            pass  # FTS unavailable in some environments; vector-only fallback

        index = cls(table, embedder)
        index._tmpdir = tmpdir
        return index

    def search(self, query: str, limit: int = 10) -> list[dict]:
        """Hybrid search: FTS keyword matches first, then semantic vector fill."""
        if self._table is None:
            return []

        seen: set[str] = set()
        merged: list[dict] = []

        # 1. Full-text search (keyword / BM25)
        try:
            fts_results = self._table.search(query, query_type="fts").limit(limit).to_list()
            for r in fts_results:
                if r["name"] not in seen:
                    merged.append(r)
                    seen.add(r["name"])
        except Exception:
            pass

        # 2. Vector search (semantic similarity) — fill remaining slots
        remaining = limit - len(merged)
        if remaining > 0:
            query_vec = self._embedder.encode([query])[0]
            vector_results = self._table.search(query_vec, query_type="vector").limit(limit).to_list()
            for r in vector_results:
                if r["name"] not in seen:
                    merged.append(r)
                    seen.add(r["name"])
                    remaining -= 1
                    if remaining == 0:
                        break

        return [
            {
                "name": r["name"],
                "signature": r["signature"],
                "description": r["description"],
            }
            for r in merged[:limit]
        ]

    def close(self) -> None:
        self._table = None
        if hasattr(self, "_tmpdir"):
            self._tmpdir.cleanup()
