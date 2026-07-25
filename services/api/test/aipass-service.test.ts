import { describe, expect, test } from "bun:test";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { ClientProviderProfileRecord } from "../src/runtime/session/session-runtime-dto.js";
import {
	AiPassDiscovery,
	type AiPassAuthorizationServerMetadata,
} from "../src/domain/aipass/aipass-discovery.js";
import { MemoryAiPassTokenStore } from "../src/domain/aipass/aipass-credentials.js";
import { AiPassService } from "../src/domain/aipass/aipass-service.js";

const METADATA: AiPassAuthorizationServerMetadata = {
	issuer: "https://aipass.one",
	authorizationEndpoint: "https://aipass.one/oauth2/authorize",
	tokenEndpoint: "https://aipass.one/oauth2/token",
	userinfoEndpoint: "https://aipass.one/oauth2/userinfo",
	revocationEndpoint: "https://aipass.one/oauth2/revoke",
};

describe("AI Pass authorization service", () => {
	test("keeps bearer tokens out of provider records and revokes on disconnect", async () => {
		const storedProfiles: ClientProviderProfileRecord[] = [];
		const savedInputs: Array<Record<string, unknown>> = [];
		const deletedIds: string[] = [];
		let cachedModels: unknown[] = [];
		const profiles = {
			listProviderProfiles: async () => storedProfiles,
			saveProviderProfile: async (input: Record<string, unknown>) => {
				savedInputs.push(input);
				const profile = {
					id: "provider_aipass",
					name: "AI Pass",
					providerPreset: "aipass",
					endpoint: input.endpoint,
					defaultModel: input.defaultModel,
					visionModel: input.visionModel,
					hasStoredApiKey: false,
					isActive: false,
				} as unknown as ClientProviderProfileRecord;
				storedProfiles.push(profile);
				return profile;
			},
			setCachedProviderModels: async (_id: string, models: unknown[]) => {
				cachedModels = models;
				return { models, cachedAt: "now" };
			},
			resolveActiveProviderProfile: async () => null,
			activateProviderProfile: async (id: string) => {
				const profile = storedProfiles.find((item) => item.id === id)!;
				return { ...profile, isActive: true };
			},
			deleteProviderProfile: async (id: string) => {
				deletedIds.push(id);
				storedProfiles.splice(
					storedProfiles.findIndex((item) => item.id === id),
					1,
				);
			},
		} as unknown as ProviderProfileService;
		const requests: Array<{ url: string; body: string }> = [];
		const fetchImpl = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const body =
				init?.body instanceof URLSearchParams
					? init.body.toString()
					: typeof init?.body === "string"
						? init.body
						: "";
			requests.push({ url, body });
			if (url === METADATA.tokenEndpoint) {
				return Response.json({
					access_token: "server-access-token",
					refresh_token: "server-refresh-token",
					token_type: "Bearer",
					expires_in: 3_600,
				});
			}
			if (url === METADATA.userinfoEndpoint) {
				return Response.json({ sub: "account" });
			}
			if (url.includes("/oauth2/v1/models")) {
				return Response.json({
					object: "list",
					data: [
						{
							id: "live-chat-model",
							methods: ["chat_completions"],
							type: "text",
						},
					],
				});
			}
			if (url === METADATA.revocationEndpoint) {
				return new Response(null, { status: 200 });
			}
			throw new Error("Unexpected test request.");
		}) as unknown as typeof fetch;
		const discovery = {
			get: async () => METADATA,
		} as unknown as AiPassDiscovery;
		const store = new MemoryAiPassTokenStore();
		const service = new AiPassService({
			config: {
				clientId: "test-public-client",
				redirectUri:
					"https://localhost:48765/oauth/aipass/callback",
				appOrigin: "https://localhost:48765",
				prerequisite: null,
			},
			store,
			profiles,
			discovery,
			fetchImpl,
			now: () => 1_000,
		});

		const launch = await service.createAuthorizationLaunch();
		const started = await service.beginAuthorization(
			launch.launchPath.split("/").at(-1)!,
		);
		const state = new URL(started.authorizationUrl).searchParams.get(
			"state",
		)!;
		await service.completeAuthorization({
			code: "authorization-code",
			state,
			transactionId: started.transactionId,
		});

		expect(savedInputs).toHaveLength(1);
		expect(savedInputs[0]?.apiKey).toBeNull();
		expect(JSON.stringify(savedInputs)).not.toContain(
			"server-access-token",
		);
		expect(JSON.stringify(savedInputs)).not.toContain(
			"server-refresh-token",
		);
		expect(cachedModels).toHaveLength(1);
		expect(await service.getStatus()).toMatchObject({
			available: true,
			connected: true,
			profileId: "provider_aipass",
		});
		expect(requests.find((request) =>
			request.url === METADATA.tokenEndpoint,
		)?.body).not.toContain("client_secret");

		const disconnected = await service.disconnect();
		expect(disconnected.revoked).toBe(true);
		expect(await store.read()).toBeNull();
		expect(deletedIds).toEqual(["provider_aipass"]);
		expect(
			requests.filter(
				(request) => request.url === METADATA.revocationEndpoint,
			),
		).toHaveLength(2);
	});
});
