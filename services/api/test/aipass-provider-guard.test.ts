import { describe, expect, test } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ProviderAdapter } from "../src/api/adapters/provider-adapter.js";
import { createProviderRoutes } from "../src/api/routes/provider.js";
import type { ProviderRuntimeApi } from "../src/api/contract/runtime-api.js";

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

	test("rejects the DNS-equivalent trailing-dot AI Pass hostname", async () => {
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
			endpoint: "https://aipass.one./oauth2/v1",
			apiKey: "must-not-be-accepted",
		})).rejects.toThrow("Connect AI Pass");
		expect(saveCalled).toBe(false);
	});

	test("updates AI Pass generation settings without hydrating its access token", async () => {
		let updated = false;
		const clientProfile = {
			id: "provider_aipass",
			name: "AI Pass",
			providerPreset: "aipass",
			endpoint: "https://aipass.one/oauth2/v1",
			hasStoredApiKey: true,
		};
		const service = {
			getProviderProfile: async () => {
				throw new Error("access token must not be hydrated");
			},
			getProviderProfileForClient: async () => clientProfile,
			updateProviderProfile: async () => {
				updated = true;
				return clientProfile;
			},
		} as unknown as ProviderProfileService;
		const adapter = new ProviderAdapter(
			{} as StoreContainer,
			service,
		);

		await expect(adapter.updateProviderProfile(
			"provider_aipass",
			{ defaultModel: "live-model" },
		)).resolves.toMatchObject({ id: "provider_aipass" });
		expect(updated).toBe(true);
	});

	test("waits for the async delete guard before returning success", async () => {
		let releaseDelete: (() => void) | undefined;
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		const runtime = {
			deleteProviderProfile: async () => {
				await deleteGate;
			},
		} as unknown as ProviderRuntimeApi;
		const app = createProviderRoutes(runtime);
		const request = app.request("/api/providers/provider_aipass", {
			method: "DELETE",
		});

		const settledBeforeGuard = await Promise.race([
			request.then(() => true),
			new Promise<false>((resolve) =>
				setTimeout(() => resolve(false), 20),
			),
		]);
		releaseDelete?.();
		await request;

		expect(settledBeforeGuard).toBe(false);
	});
});
