export const AIPASS_ISSUER = "https://aipass.one";
export const AIPASS_DISCOVERY_URL =
	"https://aipass.one/.well-known/oauth-authorization-server";
export const AIPASS_API_BASE_URL = "https://aipass.one/oauth2/v1";
export const AIPASS_MODELS_URL = "https://aipass.one/oauth2/v1/models";
export const AIPASS_CHAT_COMPLETIONS_URL =
	"https://aipass.one/oauth2/v1/chat/completions";

const CHAT_REQUEST_LIMIT_BYTES = 4 * 1024 * 1024;
const CHAT_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const CHAT_TIMEOUT_MS = 5 * 60 * 1_000;

interface CombinedSignal {
	signal: AbortSignal;
	cancelTimeout(): void;
	abort(reason?: unknown): void;
}

interface AiPassChatFetchOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	requestLimitBytes?: number;
	responseLimitBytes?: number;
}

interface BoundedJsonOptions {
	fetchImpl?: typeof fetch;
	timeoutMs: number;
	maxResponseBytes: number;
	signal?: AbortSignal;
	request?: RequestInit;
	operation: string;
}

export function isAiPassEndpoint(value: unknown): boolean {
	if (typeof value !== "string" || !value.trim()) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname.toLowerCase().replace(/\.+$/g, "") ===
				"aipass.one" &&
			(url.port === "" || url.port === "443")
		);
	} catch {
		return false;
	}
}

function combineSignal(
	external: AbortSignal | null | undefined,
	timeoutMs: number,
): CombinedSignal {
	const controller = new AbortController();
	const onAbort = () => controller.abort(external?.reason);
	if (external?.aborted) {
		controller.abort(external.reason);
	} else {
		external?.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(
		() => controller.abort(new DOMException("Timed out", "TimeoutError")),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cancelTimeout() {
			clearTimeout(timer);
			external?.removeEventListener("abort", onAbort);
		},
		abort(reason?: unknown) {
			controller.abort(reason);
		},
	};
}

function requestBodyBytes(body: BodyInit | null | undefined): number {
	if (body == null) return 0;
	if (typeof body === "string") return Buffer.byteLength(body);
	if (body instanceof URLSearchParams) {
		return Buffer.byteLength(body.toString());
	}
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (ArrayBuffer.isView(body)) return body.byteLength;
	if (body instanceof Blob) return body.size;
	throw new Error("AI Pass request body type is not supported.");
}

async function readBoundedText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error("AI Pass response exceeded its size limit.");
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("AI Pass response exceeded its size limit.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function boundedStreamingResponse(
	response: Response,
	maxBytes: number,
	signal: CombinedSignal,
): Response {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		signal.abort(new Error("AI Pass response exceeded its size limit."));
		void response.body?.cancel().catch(() => {});
		signal.cancelTimeout();
		throw new Error("AI Pass response exceeded its size limit.");
	}
	if (!response.body) {
		signal.cancelTimeout();
		return response;
	}

	const reader = response.body.getReader();
	let total = 0;
	let settled = false;
	const cleanup = () => {
		if (settled) return;
		settled = true;
		signal.signal.removeEventListener("abort", onAbort);
		signal.cancelTimeout();
	};
	const onAbort = () => {
		void reader.cancel(signal.signal.reason).catch(() => {});
		cleanup();
	};
	signal.signal.addEventListener("abort", onAbort, { once: true });
	if (signal.signal.aborted) onAbort();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					cleanup();
					controller.close();
					return;
				}
				total += value.byteLength;
				if (total > maxBytes) {
					const error = new Error(
						"AI Pass response exceeded its size limit.",
					);
					signal.abort(error);
					await reader.cancel(error);
					cleanup();
					controller.error(error);
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				cleanup();
				controller.error(error);
			}
		},
		async cancel(reason) {
			signal.abort(reason);
			cleanup();
			await reader.cancel(reason).catch(() => {});
		},
	});

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export function createAiPassChatFetch(
	options: AiPassChatFetchOptions = {},
): typeof fetch {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? CHAT_TIMEOUT_MS;
	const requestLimit = options.requestLimitBytes ?? CHAT_REQUEST_LIMIT_BYTES;
	const responseLimit =
		options.responseLimitBytes ?? CHAT_RESPONSE_LIMIT_BYTES;

	const chatFetch = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		const url =
			typeof input === "string" || input instanceof URL
				? new URL(input)
				: new URL(input.url);
		if (url.href !== AIPASS_CHAT_COMPLETIONS_URL) {
			throw new Error("AI Pass transport rejected an unexpected endpoint.");
		}
		const method = (
			init?.method ??
			(input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (method !== "POST") {
			throw new Error("AI Pass transport only permits POST requests.");
		}
		const body = init?.body ?? (input instanceof Request ? input.body : null);
		if (requestBodyBytes(body) > requestLimit) {
			throw new Error("AI Pass request exceeded its size limit.");
		}

		const externalSignal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const combined = combineSignal(externalSignal, timeoutMs);
		try {
			const response = await fetchImpl(input, {
				...init,
				signal: combined.signal,
			});
			return boundedStreamingResponse(response, responseLimit, combined);
		} catch (error) {
			combined.cancelTimeout();
			throw error;
		}
	};
	return Object.assign(chatFetch, {
		preconnect: fetch.preconnect,
	});
}

export async function fetchAiPassBoundedJson(
	url: string,
	options: BoundedJsonOptions,
): Promise<{ response: Response; payload: unknown }> {
	const combined = combineSignal(options.signal, options.timeoutMs);
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			...options.request,
			signal: combined.signal,
		});
		const text = await readBoundedText(
			response,
			options.maxResponseBytes,
		);
		if (!response.ok) {
			throw new Error(
				`${options.operation} failed with status ${response.status}.`,
			);
		}
		let payload: unknown;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			throw new Error(`${options.operation} returned invalid JSON.`);
		}
		return { response, payload };
	} catch (error) {
		if (
			error instanceof Error &&
			(error.name === "TimeoutError" ||
				combined.signal.reason instanceof DOMException &&
					combined.signal.reason.name === "TimeoutError")
		) {
			throw new Error(`${options.operation} timed out.`);
		}
		throw error;
	} finally {
		combined.cancelTimeout();
	}
}
