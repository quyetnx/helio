"""Anthropic (Claude) provider.

Anthropic differs from the OpenAI surface: the system prompt is a
separate parameter, tool calls and results are content blocks, and
``max_tokens`` is required. This module hides those differences.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from anthropic import AsyncAnthropic, BadRequestError

from .types import (
    LLMResponse,
    Message,
    SystemMessage,
    ToolCall,
    ToolMessage,
    ToolSpec,
    Usage,
    UserMessage,
)

# Anthropic requires an explicit max; pick a generous default.
_DEFAULT_MAX_TOKENS = 2048


def _rejects_temperature(error: BadRequestError) -> bool:
    """True when the API refused the request because of ``temperature``.

    Newer Claude models no longer accept the sampling parameter and answer
    400 (e.g. "`temperature` is deprecated for this model").
    """
    return "temperature" in str(error).lower()


def _to_anthropic_messages(messages: Sequence[Message]) -> tuple[str, list[dict[str, Any]]]:
    """Split out the system prompt and translate the rest to Anthropic blocks."""
    system_parts: list[str] = []
    converted: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, SystemMessage):
            system_parts.append(message.content)
        elif isinstance(message, UserMessage):
            converted.append({"role": "user", "content": message.content})
        elif isinstance(message, ToolMessage):
            converted.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.tool_call_id,
                            "content": message.content,
                        }
                    ],
                }
            )
        else:  # AssistantMessage
            blocks: list[dict[str, Any]] = []
            if message.content:
                blocks.append({"type": "text", "text": message.content})
            for call in message.tool_calls:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }
                )
            converted.append({"role": "assistant", "content": blocks})
    return "\n\n".join(system_parts), converted


class AnthropicProvider:
    """Chat completions over Anthropic's Messages API."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str | None = None,
        name: str = "anthropic",
        timeout: float = 60.0,
    ) -> None:
        self.name = name
        self.model = model
        self._client = AsyncAnthropic(api_key=api_key, base_url=base_url, timeout=timeout)
        # Flipped once the model rejects ``temperature``; later calls omit it.
        self._temperature_supported = True

    async def complete(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> LLMResponse:
        system, converted = _to_anthropic_messages(messages)
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": converted,
            "max_tokens": max_tokens or _DEFAULT_MAX_TOKENS,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.parameters,
                }
                for tool in tools
            ]
        if temperature is not None and self._temperature_supported:
            kwargs["temperature"] = temperature

        try:
            response = await self._client.messages.create(**kwargs)
        except BadRequestError as error:
            if "temperature" not in kwargs or not _rejects_temperature(error):
                raise
            self._temperature_supported = False
            del kwargs["temperature"]
            response = await self._client.messages.create(**kwargs)

        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                arguments = block.input if isinstance(block.input, dict) else {}
                tool_calls.append(ToolCall(id=block.id, name=block.name, arguments=arguments))

        usage = Usage(
            prompt_tokens=getattr(response.usage, "input_tokens", 0) or 0,
            completion_tokens=getattr(response.usage, "output_tokens", 0) or 0,
        )
        return LLMResponse(
            text="".join(text_parts),
            tool_calls=tuple(tool_calls),
            finish_reason=response.stop_reason or "stop",
            usage=usage,
        )
