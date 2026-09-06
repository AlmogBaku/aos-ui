import pytest
from mcp.types import Tool
from pydantic_monty import MontyError

from monty.exec import Executor


@pytest.mark.asyncio
async def test_returns_the_execution_value_directly():
    executor = Executor([])
    assert await executor.execute("6 * 7") == 42
    assert await executor.execute("import json\njson.loads('{\"answer\": 42}')") == {"answer": 42}


@pytest.mark.asyncio
async def test_syntax_and_type_errors_remain_errors():
    executor = Executor([])
    for code in ("await (", 'value: int = "text"'):
        with pytest.raises(MontyError):
            await executor.execute(code)


def test_downstream_cannot_silently_shadow_a_builtin():
    with pytest.raises(ValueError, match="Duplicate tool name: math_add"):
        Executor([Tool(name="math_add", inputSchema={})])


@pytest.mark.asyncio
async def test_builtin_helpers_and_seeded_randomness():
    executor = Executor([])
    assert await executor.execute('await stdlib_functools_reduce("add", [1, 2, 3], 0)') == 6
    assert await executor.execute('await stdlib_binascii_hexlify("A")') == "41"
    assert await executor.execute('await stdlib_binascii_unhexlify("41")') == "A"
    assert await executor.execute("await math_sqrt(value=81)") == 9
    assert await executor.execute("await math_power(a=2, b=3)") == 8
    code = "await random_integer(1, 100, seed=42)"
    assert await executor.execute(code) == await executor.execute(code)
