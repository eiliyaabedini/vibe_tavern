import type { ProviderModelOption } from "../providers/provider-transport.js";

interface AiPassModelRecord {
	id?: unknown;
	name?: unknown;
	type?: unknown;
	methods?: unknown;
	context_length?: unknown;
	contextLength?: unknown;
	capabilities?: unknown;
	description?: unknown;
	pricing?: unknown;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim()
		? value.trim()
		: undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0
		? value
		: undefined;
}

function stringSet(value: unknown): Set<string> {
	if (!Array.isArray(value)) return new Set();
	return new Set(
		value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean),
	);
}

function pricingValue(value: unknown): { input?: number; output?: number } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const input = typeof record.input === "number"
		? record.input
		: typeof record.prompt === "number"
			? record.prompt
			: undefined;
	const output = typeof record.output === "number"
		? record.output
		: typeof record.completion === "number"
			? record.completion
			: undefined;
	return input === undefined && output === undefined
		? undefined
		: {
			...(input !== undefined ? { input } : {}),
			...(output !== undefined ? { output } : {}),
		};
}

function isChatModel(record: AiPassModelRecord): boolean {
	const methods = stringSet(record.methods);
	if (methods.size > 0) return methods.has("chat_completions");
	const type = stringValue(record.type)?.toLowerCase();
	return type === undefined || type === "text" || type === "multimodal";
}

function parseRecord(value: unknown): ProviderModelOption | null {
	if (typeof value === "string") {
		const id = stringValue(value);
		return id ? { id, label: id } : null;
	}
	if (!value || typeof value !== "object") return null;

	const record = value as AiPassModelRecord;
	const id = stringValue(record.id) ?? stringValue(record.name);
	if (!id || !isChatModel(record)) return null;

	const capabilities = stringSet(record.capabilities);
	const contextLength = positiveInteger(
		record.context_length ?? record.contextLength,
	);
	const pricing = pricingValue(record.pricing);
	const description = stringValue(record.description);

	return {
		id,
		label: stringValue(record.name) ?? id,
		...(contextLength !== undefined ? { contextLength } : {}),
		...(capabilities.size > 0
			? {
				capabilities: {
					reasoning:
						capabilities.has("reasoning") ||
						capabilities.has("thinking"),
					tools:
						capabilities.has("tools") ||
						capabilities.has("function_calling"),
					vision:
						capabilities.has("vision") ||
						capabilities.has("image") ||
						capabilities.has("multimodal"),
					webSearch:
						capabilities.has("web_search") ||
						capabilities.has("web-search"),
				},
			}
			: {}),
		...(pricing ? { pricing } : {}),
		...(description ? { description } : {}),
	};
}

export function parseAiPassModels(payload: unknown): ProviderModelOption[] {
	const records = Array.isArray(payload)
		? payload
		: payload &&
			  typeof payload === "object" &&
			  Array.isArray((payload as { data?: unknown }).data)
			? (payload as { data: unknown[] }).data
			: [];

	const byId = new Map<string, ProviderModelOption>();
	for (const record of records) {
		const parsed = parseRecord(record);
		if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, parsed);
	}
	return [...byId.values()].sort((left, right) =>
		left.label.localeCompare(right.label),
	);
}
