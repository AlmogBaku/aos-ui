import pytest

from aos_hermes.creator import Creator, CreatorConfig


def test_creator_fails_closed_without_invoking_native_hermes():
    calls = []
    creator = Creator(
        CreatorConfig("hermes", "source", "a" * 40),
        runner=lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    with pytest.raises(RuntimeError, match="atomic public profile create"):
        creator.create(
            "new-agent",
            "A safe research agent",
            "Research carefully and cite evidence.",
            ["structured-presentations", "session-handoff"],
        )

    assert calls == []


def test_creator_rejects_unsafe_profile_and_invalid_capabilities():
    creator = Creator(
        CreatorConfig("hermes", "source", "b" * 40),
        runner=lambda *_args, **_kwargs: None,
    )
    for name in ("default", "../escape", "A"):
        with pytest.raises(ValueError):
            creator.create(name, "Agent", "Do work", ["structured-presentations"])

    with pytest.raises(ValueError):
        creator.create("safe-agent", "Agent", "Do work", ["shell"])
