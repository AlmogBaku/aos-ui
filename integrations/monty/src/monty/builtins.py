"""Additional Python helpers available alongside downstream MCP tools."""

import base64
import binascii
import functools
import math
import operator
import random
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class Builtin:
    name: str
    description: str
    function: Callable[..., Any]
    signature: str

    def metadata(self) -> dict[str, str]:
        return {"name": self.name, "signature": self.signature, "description": self.description}


def _reduce(operation: str, values: list[Any], initial: Any) -> Any:
    operations = {
        "add": operator.add,
        "multiply": operator.mul,
        "min": min,
        "max": max,
    }
    try:
        function = operations[operation]
    except KeyError as exc:
        raise ValueError("operation must be add, multiply, min, or max") from exc
    return functools.reduce(function, values, initial)


def _decode_text(value: str) -> str:
    return base64.b64decode(value, validate=True).decode("utf-8")


def _unhexlify(value: str) -> str:
    return binascii.unhexlify(value).decode("utf-8")


def default_builtins() -> tuple[Builtin, ...]:
    return (
        Builtin("math_add", "Add two numbers.", lambda a, b: a + b, "async def math_add(a: float, b: float) -> float"),
        Builtin(
            "math_subtract",
            "Subtract b from a.",
            lambda a, b: a - b,
            "async def math_subtract(a: float, b: float) -> float",
        ),
        Builtin(
            "math_multiply",
            "Multiply two numbers.",
            lambda a, b: a * b,
            "async def math_multiply(a: float, b: float) -> float",
        ),
        Builtin(
            "math_divide", "Divide a by b.", lambda a, b: a / b, "async def math_divide(a: float, b: float) -> float"
        ),
        Builtin(
            "math_power",
            "Raise a to exponent b.",
            lambda a, b: pow(a, b),
            "async def math_power(a: float, b: float) -> float",
        ),
        Builtin(
            "math_sqrt",
            "Return the square root of a number.",
            lambda value: math.sqrt(value),
            "async def math_sqrt(value: float) -> float",
        ),
        Builtin(
            "random_integer",
            "Return a non-cryptographic random integer; an optional seed makes it reproducible.",
            lambda low, high, seed=None: random.Random(seed).randint(low, high),
            "async def random_integer(low: int, high: int, seed: int | None = None) -> int",
        ),
        Builtin(
            "random_float",
            "Return a non-cryptographic random float; an optional seed makes it reproducible.",
            lambda seed=None: random.Random(seed).random(),
            "async def random_float(seed: int | None = None) -> float",
        ),
        Builtin(
            "random_choice",
            "Choose from a non-empty list using non-cryptographic randomness; an optional seed makes it reproducible.",
            lambda values, seed=None: random.Random(seed).choice(values),
            "async def random_choice(values: list[object], seed: int | None = None) -> object",
        ),
        Builtin(
            "stdlib_functools_reduce",
            "Safe functools.reduce subset supporting add, multiply, min, and max.",
            _reduce,
            "async def stdlib_functools_reduce(operation: str, values: list[object], initial: object) -> object",
        ),
        Builtin(
            "stdlib_base64_b64encode",
            "Encode UTF-8 text as base64 text.",
            lambda value: base64.b64encode(value.encode("utf-8")).decode("ascii"),
            "async def stdlib_base64_b64encode(value: str) -> str",
        ),
        Builtin(
            "stdlib_base64_b64decode",
            "Decode validated base64 text as UTF-8 text.",
            _decode_text,
            "async def stdlib_base64_b64decode(value: str) -> str",
        ),
        Builtin(
            "stdlib_binascii_hexlify",
            "Encode UTF-8 text as lowercase hexadecimal text.",
            lambda value: binascii.hexlify(value.encode("utf-8")).decode("ascii"),
            "async def stdlib_binascii_hexlify(value: str) -> str",
        ),
        Builtin(
            "stdlib_binascii_unhexlify",
            "Decode hexadecimal text as UTF-8 text.",
            _unhexlify,
            "async def stdlib_binascii_unhexlify(value: str) -> str",
        ),
    )
