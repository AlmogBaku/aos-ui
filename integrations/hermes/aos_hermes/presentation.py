from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from jsonschema import ValidationError, validate


class PresentationError(ValueError):
    pass


class PresentationTools:
    def __init__(self, artifact_path: str | Path):
        value = json.loads(Path(artifact_path).read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("tools"), list):
            raise PresentationError("Invalid generated presentation catalog")
        self.instructions = str(value.get("instructions") or "")
        self.schemas = {
            item["name"]: item for item in value["tools"]
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        }

    def handle(self, name: str, args: dict[str, Any]) -> str:
        definition = self.schemas.get(name)
        if definition is None:
            raise PresentationError("Unknown presentation tool")
        if not isinstance(args, dict):
            raise PresentationError("Presentation payload must be an object")
        try:
            validate(args, definition.get("parameters") or {})
        except ValidationError as exc:
            raise PresentationError(f"Expected a valid {name} payload") from exc
        if name == "render_chart":
            self._validate_chart(args, set(definition.get("semanticRules") or []))
        return json.dumps({"ok": True, "value": args}, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

    @staticmethod
    def _validate_chart(chart: dict[str, Any], rules: set[str]) -> None:
        rows = chart.get("data")
        series = chart.get("series")
        x_key = chart.get("xKey")
        if not isinstance(rows, list) or not rows or not isinstance(series, list) or not series:
            raise PresentationError("Chart requires non-empty data and series")
        if "chart-axis-present" in rules:
            if not isinstance(x_key, str) or not x_key or any(not isinstance(row, dict) or x_key not in row for row in rows):
                raise PresentationError("Chart axes must be present in every row")
        keys = [item.get("key") for item in series if isinstance(item, dict)]
        if len(keys) != len(series) or any(not isinstance(key, str) or not key for key in keys):
            raise PresentationError("Chart series keys are required")
        if "chart-series-numeric" in rules:
            for row in rows:
                for key in keys:
                    value = row.get(key) if isinstance(row, dict) else None
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                        raise PresentationError("Chart series values must be finite numbers")
        if chart.get("type", "line") == "pie" and "pie-single-series-positive-total" in rules:
            if len(keys) != 1:
                raise PresentationError("Pie charts require exactly one series")
            values = [row[keys[0]] for row in rows]
            if any(value < 0 for value in values) or sum(values) <= 0:
                raise PresentationError("Pie chart values must be non-negative with a positive total")
