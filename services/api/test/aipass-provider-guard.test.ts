import { describe, expect, test } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ProviderAdapter } from "../src/api/adapters/provider-adapter.js";

describe("AI Pass provider account boundary", () => {
	test("cannot be created through the generic API-key provider draft path", async () => {
		let saveCalled = false;
		const service = {
			saveProviderProfile: async () => {
				saveCalled = true;
				throw new Error("must not be called");
			},
		} as unknown as ProviderProfileService;
		const adapter = new ProviderAdapter(
			{} as StoreContainer,
			service,
		);

		await expect(adapter.saveProviderDraft({
			name: "AI Pass as BYOK",
			providerPreset: "aipass",
			endpoint: "https://aipass.one/oauth2/v1",
			apiKey: "must-not-be-accepted",
		})).rejects.toThrow("Connect AI Pass");
		expect(saveCalled).toBe(false);
	});

	test("cannot use AI Pass through generic endpoint testing", async () => {
		const adapter = new ProviderAdapter(
			{} as StoreContainer,
			{} as ProviderProfileService,
		);

		await expect(adapter.testProviderChatByEndpoint({
			baseUrl: "https://aipass.one/oauth2/v1",
			apiKey: "must-not-be-accepted",
			model: "live-model",
			providerType: "aipass",
		})).rejects.toThrow("Connect AI Pass");
	});

	test("cannot disguise the AI Pass endpoint as an OpenAI-compatible BYOK profile", async () => {
		let saveCalled = false;
		const service = {
			saveProviderProfile: async () => {
				saveCalled = true;
				throw new Error("must not be called");
			},
		} as unknown as ProviderProfileService;
		const adapter = new ProviderAdapter(
			{} as StoreContainer,
			service,
		);

		await expect(adapter.saveProviderDraft({
			name: "Disguised AI Pass",
			providerPreset: "openai",
			endpoint: "https://aipass.one/oauth2/v1",
			apiKey: "must-not-be-accepted",
		})).rejects.toThrow("Connect AI Pass");
		expect(saveCalled).toBe(false);
	});
});
