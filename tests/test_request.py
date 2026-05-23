"""Tests for request converter (Claude messages → Antigravity prompt)."""

import pytest
from claude2gemini.converters.request import (
    convert_messages_to_prompt,
    extract_system_prompt,
    map_model_name,
)
from claude2gemini.types import ClaudeMessage, ClaudeTextBlock, ClaudeToolResultBlock


class TestMapModelName:
    def test_opus_maps_to_gemini_3_pro(self):
        assert map_model_name("claude-3-opus-20240229") == "gemini-3.1-pro-preview"

    def test_sonnet_maps_to_gemini_3_flash(self):
        assert map_model_name("claude-3-sonnet-20240229") == "gemini-3-flash-preview"

    def test_haiku_maps_to_gemini_3_flash_lite(self):
        assert map_model_name("claude-3-haiku-20240307") == "gemini-2.5-flash-lite"

    def test_gemini_model_passed_through(self):
        result = map_model_name("gemini-2.0-flash-exp")
        assert result == "gemini-2.0-flash-exp"

    def test_unknown_model_falls_back_to_default(self):
        result = map_model_name("unknown-model")
        assert result == "gemini-3-flash-preview"


class TestConvertMessagesToPrompt:
    @pytest.mark.asyncio
    async def test_correctly_interpolates_tool_result(self):
        """TS equivalent: test_correctly_interpolates_tool_result"""
        messages = [
            ClaudeMessage(
                role="user",
                content=[
                    ClaudeToolResultBlock(
                        tool_use_id="tool-123", content="result text"
                    )
                ],
            )
        ]
        result = await convert_messages_to_prompt(messages)
        assert "[Tool Result tool-123: result text]" in result.prompt
        assert result.inline_data_parts == []

    @pytest.mark.asyncio
    async def test_processes_image_block(self):
        """TS equivalent: test_processes_image_block_correctly"""
        messages = [
            ClaudeMessage(
                role="user",
                content=[
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": "dGVzdA==",
                        },
                    }
                ],
            )
        ]
        result = await convert_messages_to_prompt(messages)
        assert len(result.inline_data_parts) == 1
        assert result.inline_data_parts[0]["inlineData"]["mimeType"] == "image/jpeg"
        assert result.inline_data_parts[0]["inlineData"]["data"] == "dGVzdA=="
        assert "[Attached: image/jpeg]" in result.prompt

    @pytest.mark.asyncio
    async def test_processes_document_block(self):
        """TS equivalent: test_processes_document_block_correctly"""
        messages = [
            ClaudeMessage(
                role="user",
                content=[
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": "UERG",
                        },
                    }
                ],
            )
        ]
        result = await convert_messages_to_prompt(messages)
        assert len(result.inline_data_parts) == 1
        assert result.inline_data_parts[0]["inlineData"]["mimeType"] == "application/pdf"
        assert result.inline_data_parts[0]["inlineData"]["data"] == "UERG"
        assert "[Attached: application/pdf]" in result.prompt

    @pytest.mark.asyncio
    async def test_multi_turn_conversation(self):
        messages = [
            ClaudeMessage(role="user", content="Hello"),
            ClaudeMessage(role="assistant", content="Hi there!"),
            ClaudeMessage(role="user", content="What's the weather?"),
        ]
        result = await convert_messages_to_prompt(messages)
        assert "User: Hello" in result.prompt
        assert "Assistant: Hi there!" in result.prompt
        assert "User: What's the weather?" in result.prompt

    @pytest.mark.asyncio
    async def test_empty_messages_raises(self):
        with pytest.raises(ValueError):
            await convert_messages_to_prompt([])

    @pytest.mark.asyncio
    async def test_unknown_block_type_skipped(self):
        # Use model_construct to bypass strict validation (simulates raw API data)
        msg = ClaudeMessage.model_construct(
            role="user",
            content=[
                ClaudeTextBlock(text="hello"),
                {"type": "unknown_type", "value": "something"},
            ],
        )
        result = await convert_messages_to_prompt([msg])
        assert result.prompt == "hello"

    @pytest.mark.asyncio
    async def test_single_text_message(self):
        messages = [ClaudeMessage(role="user", content="Just text")]
        result = await convert_messages_to_prompt(messages)
        assert result.prompt == "Just text"
        assert result.inline_data_parts == []


class TestExtractSystemPrompt:
    def test_string_system(self):
        assert extract_system_prompt("Be helpful.") == "Be helpful."

    def test_array_of_text_blocks(self):
        result = extract_system_prompt(
            [{"type": "text", "text": "Be helpful."}, {"type": "text", "text": "Be concise."}]
        )
        assert result == "Be helpful.\nBe concise."

    def test_none_returns_none(self):
        assert extract_system_prompt(None) is None

    def test_empty_array_returns_empty(self):
        assert extract_system_prompt([]) == ""
