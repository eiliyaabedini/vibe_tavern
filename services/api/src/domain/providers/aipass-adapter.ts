import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import {
	AIPASS_API_BASE_URL,
	AIPASS_CHAT_COMPLETIONS_URL,
	AIPASS_MODELS_URL,
	createAiPassChatFetch,
	fetchAiPassBoundedJson,
} from "../aipass/aipass-transport.js";
import { parseAiPassModels } from "../aipass/aipass-models.js";
import { extractChoiceContent } from "./provider-transport.js";
import type {
	ProviderConnectionInput,
	TestChatResult,
} from "./provider-transport.js";
import type {
	ListModelsInput,
	ProbeInput,
	ProtocolAdapter,
} from "./protocol-types.js";

const MODEL_TIMEOUT_MS = 15_000;
const MODEL_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const TEST_CHAT_TIMEOUT_MS = 30_000;
const TEST_CHAT_RESPONSE_LIMIT_BYTES = 256 * 1024;

function bearerHeaders(accessToken: string, withBody = false): HeadersInit {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
		...(withBody ? { "Content-Type": "application/json" } : {}),
	};
}

async function listModels(input: ListModelsInput) {
	if (!input.apiKey) throw new Error("Connect AI Pass to fetch live models.");
	const { payload } = await fetchAiPassBoundedJson(AIPASS_MODELS_URL, {
		operation: "AI Pass model discovery",
		timeoutMs: MODEL_TIMEOUT_MS,
		maxResponseBytes: MODEL_RESPONSE_LIMIT_BYTES,
		request: {
			method: "GET",
			headers: bearerHeaders(input.apiKey),
		},
	});
	return parseAiPassModels(payload);
}

async function probe(input: ProbeInput) {
	if (!input.apiKey) {
		return { success: false, error: "Connect AI Pass first." };
	}
	try {
		const models = await listModels({
			baseUrl: AIPASS_API_BASE_URL,
			apiKey: input.apiKey,
		});
		return { success: true, modelCount: models.length };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "AI Pass model discovery failed.",
		};
	}
}

async function testChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	if (!input.apiKey) return { success: false, error: "Connect AI Pass first." };
	if (!input.model) return { success: false, error: "Model is required." };
	try {
		const { payload } = await fetchAiPassBoundedJson(
			AIPASS_CHAT_COMPLETIONS_URL,
			{
				operation: "AI Pass test chat",
				timeoutMs: TEST_CHAT_TIMEOUT_MS,
				maxResponseBytes: TEST_CHAT_RESPONSE_LIMIT_BYTES,
				request: {
					method: "POST",
					headers: bearerHeaders(input.apiKey, true),
					body: JSON.stringify({
						model: input.model,
						messages: [{ role: "user", content: "Hi" }],
						max_tokens: 64,
						stream: false,
					}),
				},
			},
		);
		const record =
			payload && typeof payload === "object"
				? (payload as {
						choices?: Array<{
							message?: {
								content?:
									| string
									| Array<{ type?: string; text?: string }>;
							};
							text?: string;
						}>;
					})
				: {};
		const reply = extractChoiceContent(record.choices?.[0]);
		return { success: true, reply: reply || "(empty response)" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "AI Pass test chat failed.",
		};
	}
}

export const aiPassProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.aiPass,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.minimal_reasoning,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		if (!profile.apiKey) {
			throw new Error("AI Pass is not connected.");
		}
		const provider = createOpenAICompatible({
			name: "aipass",
			apiKey: profile.apiKey,
			baseURL: AIPASS_API_BASE_URL,
			fetch: createAiPassChatFetch(),
			supportsStructuredOutputs: true,
		});
		return provider.chatModel(model);
	},
	limitations: [
		"Requires a connected AI Pass account.",
		"Models are discovered live from AI Pass.",
	],
	probe,
	testChat,
	listModels,
};
