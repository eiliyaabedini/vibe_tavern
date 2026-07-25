import { describe, expect, test } from "bun:test";
import {
	AIPASS_CHAT_COMPLETIONS_URL,
	createAiPassChatFetch,
} from "../src/domain/aipass/aipass-transport.js";

describe("AI Pass wallet-billed transport", () => {
	test("propagates caller cancellation to the upstream request", async () => {
		let upstreamSignal: AbortSignal | null = null;
		const fetchImpl: typeof fetch = async (_input, init) => {
			upstreamSignal = init?.signal ?? null;
			return new Response("data: done\n\n", {
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		const transport = createAiPassChatFetch({ fetchImpl });
		const controller = new AbortController();

		await transport(AIPASS_CHAT_COMPLETIONS_URL, {
			method: "POST",
			body: "{}",
			signal: controller.signal,
		});
		controller.abort();

		expect(upstreamSignal?.aborted).toBe(true);
	});

	test("fails closed for any endpoint other than AI Pass chat completions", async () => {
		let called = false;
		const transport = createAiPassChatFetch({
			fetchImpl: async () => {
				called = true;
				return new Response();
			},
		});

		await expect(transport("https://attacker.example/chat/completions", {
			method: "POST",
			body: "{}",
		})).rejects.toThrow("endpoint");
		expect(called).toBe(false);
	});
});
