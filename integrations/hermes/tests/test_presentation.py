import json
import math
from pathlib import Path

import pytest

from aos_hermes.presentation import PresentationError, PresentationTools


@pytest.fixture
def tools(tmp_path):
    artifact = tmp_path / "presentation.json"
    artifact.write_text(json.dumps({
        "tools": [{
            "name": "render_chart", "description": "chart",
            "parameters": {"type": "object"},
            "semanticRules": ["chart-axis-present", "chart-series-numeric", "pie-single-series-positive-total"],
        }],
        "instructions": "tools",
    }))
    return PresentationTools(artifact)


def test_chart_requires_axes_for_non_pie_chart(tools):
    with pytest.raises(PresentationError, match="axes"):
        tools.handle("render_chart", {
            "type": "line", "xKey": "month", "series": [{"key": "sales", "label": "Sales"}],
            "data": [{"sales": 1}],
        })


@pytest.mark.parametrize("bad", [math.nan, math.inf, "1"])
def test_chart_series_values_are_finite_numbers(tools, bad):
    with pytest.raises(PresentationError, match="finite"):
        tools.handle("render_chart", {
            "type": "line", "xKey": "month", "series": [{"key": "sales", "label": "Sales"}],
            "data": [{"month": "Jan", "sales": bad}],
        })


def test_pie_requires_one_nonnegative_series_with_positive_total(tools):
    with pytest.raises(PresentationError, match="positive"):
        tools.handle("render_chart", {"type": "pie", "xKey": "name", "series": [{"key": "value", "label": "Value"}], "data": [{"name": "A", "value": 0}]})
    with pytest.raises(PresentationError, match="one series"):
        tools.handle("render_chart", {"type": "pie", "xKey": "name", "series": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}], "data": [{"name": "A", "a": 1, "b": 2}]})


def test_generated_json_schema_is_enforced_before_returning_payload(tmp_path):
    artifact = tmp_path / "presentation.json"
    artifact.write_text(json.dumps({
        "tools": [{"name": "render_map", "description": "map", "parameters": {
            "type": "object", "properties": {"title": {"type": "string", "minLength": 1}},
            "required": ["title"], "additionalProperties": False,
        }}], "instructions": "tools",
    }))
    with pytest.raises(PresentationError, match="valid render_map payload"):
        PresentationTools(artifact).handle("render_map", {"title": "", "secret": "not allowed"})


def test_every_canonical_generated_example_passes_native_validation():
    artifact = Path(__file__).parents[1] / "aos_hermes" / "_generated" / "presentation.json"
    catalog = json.loads(artifact.read_text(encoding="utf-8"))
    tools = PresentationTools(artifact)
    validated = []
    for definition in catalog["tools"]:
        for example in definition.get("examples", []):
            result = json.loads(tools.handle(definition["name"], example))
            assert result == {"ok": True, "value": example}
            validated.append(definition["name"])
    assert validated == ["render_chart", "render_map", "render_stats", "present_plan"]
