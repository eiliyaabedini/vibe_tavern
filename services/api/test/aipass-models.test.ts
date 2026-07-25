import { describe, expect, test } from "bun:test";
import { parseAiPassModels } from "../src/domain/aipass/aipass-models.js";
import { AIPASS_MODELS_URL } from "../src/domain/aipass/aipass-transport.js";

describe("AI Pass live model discovery", () => {
	test("uses the default OpenAI-compatible models endpoint", () => {
		expect(AIPASS_MODELS_URL).toBe(
			"https://aipass.one/oauth2/v1/models",
		);
	});

	test("accepts the OpenAI list envelope and keeps chat-completion models only", () => {
		const models = parseAiPassModels({
			object: "list",
			data: [
				{
					id: "openrouter/meta-llama/llama-3.3-70b-instruct",
					name: "Chat Model",
					type: "multimodal",
					methods: ["chat_completions", "responses"],
					context_length: 128_000,
					capabilities: ["streaming", "tools", "vision"],
					owned_by: "openrouter",
					additive_field_from_future_api: { safe: true },
				},
				{
					id: "embedding-model",
					type: "embedding",
					methods: ["embeddings"],
				},
			],
		});

		expect(models).toEqual([
			{
				id: "openrouter/meta-llama/llama-3.3-70b-instruct",
				label: "Chat Model",
				contextLength: 128_000,
				capabilities: {
					reasoning: false,
					tools: true,
					vision: true,
					webSearch: false,
				},
			},
		]);
	});

	test("preserves IDs byte-for-byte", () => {
		const id = " openrouter/provider-prefixed-id ";
		expect(
			parseAiPassModels({
				object: "list",
				data: [{ id }],
			}),
		).toEqual([{ id, label: id }]);
	});

	test("accepts legacy arrays while rejecting invalid IDs and name fallbacks", () => {
		expect(parseAiPassModels([
			"model-b",
			{ id: "provider/model-a", additive: true },
			"",
			{ id: 42, name: "must-not-be-used" },
			{ id: "  ", name: "must-not-be-used" },
			{ name: "must-not-be-used" },
			"model-b",
		])).toEqual([
			{ id: "model-b", label: "model-b" },
			{ id: "provider/model-a", label: "provider/model-a" },
		]);
		expect(parseAiPassModels({ object: "list", data: [] })).toEqual([]);
	});

	test("rejects malformed OpenAI-compatible envelopes", () => {
		expect(
			parseAiPassModels({
				object: "not-a-list",
				data: [{ id: "must-not-pass" }],
			}),
		).toEqual([]);
		expect(parseAiPassModels({ data: "not-an-array" })).toEqual([]);
	});
});
