import sys

import pytest

from monty.builtins import default_builtins
from monty.search import ToolSearchIndex


@pytest.mark.asyncio
async def test_small_catalog_needs_no_semantic_packages(monkeypatch):
    monkeypatch.setitem(sys.modules, "lancedb", None)
    monkeypatch.setitem(sys.modules, "sentence_transformers", None)
    entries = [tool.metadata() for tool in default_builtins()]
    index = await ToolSearchIndex.create(entries, embedding_threshold=len(entries))
    assert index.search("square root")[0]["name"] == "math_sqrt"
    assert index.search("randm integer")[0]["name"] == "random_integer"
    assert index.search("b64 encode")[0]["name"] == "stdlib_base64_b64encode"
    assert len(index.search("", limit=len(entries))) == len(entries)
    assert index.search("", limit=0) == []


class TestEmbedder:
    """Controlled embeddings isolate retrieval from a model download."""

    def encode(self, texts):
        return [[1.0, 0.0] if "invoice" in text or "unpaid" in text else [0.0, 1.0] for text in texts]


@pytest.mark.asyncio
async def test_large_catalog_combines_exact_and_semantic_retrieval():
    pytest.importorskip("lancedb", reason="Install the semantic extra to test vector retrieval")
    entries = [
        {"name": "invoice_list", "signature": "async def invoice_list() -> list", "description": "List invoices."},
        {"name": "weather", "signature": "async def weather() -> str", "description": "Weather report."},
    ]
    index = await ToolSearchIndex.create(entries, embedding_threshold=1, embedder=TestEmbedder())
    assert index.search("unpaid", limit=1)[0]["name"] == "invoice_list"
    assert index.search("weather", limit=1)[0]["name"] == "weather"
    assert index.search("unpaid", limit=0) == []
    index.close()
