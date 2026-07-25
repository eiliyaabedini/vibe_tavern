import { describe, expect, test } from "bun:test";
import { parseAiPassModels } from "../src/domain/aipass/aipass-models.js";

describe("AI Pass live model discovery", () => {
	test("accepts the OpenAI list envelope and keeps chat-completion models only", () => {
		const models = parseAiPassModels({
			object: "list",
			data: [
				{
					id: "chat-model",
					name: "Chat Model",
					type: "multimodal",
					methods: ["chat_completions", "responses"],
					context_length: 128_000,
					capabilities: ["streaming", "tools", "vision"],
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
				id: "chat-model",
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

	test("accepts the legacy string-array response without hardcoded fallbacks", () => {
		expect(parseAiPassModels(["model-b", "model-a", "", "model-a"])).toEqual([
			{ id: "model-a", label: "model-a" },
			{ id: "model-b", label: "model-b" },
		]);
		expect(parseAiPassModels({ object: "list", data: [] })).toEqual([]);
	});
});
