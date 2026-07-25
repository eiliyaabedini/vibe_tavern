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

function createProfileHarness() {
	const storedProfiles: ClientProviderProfileRecord[] = [];
	let activeId: string | null = null;
	const profiles = {
		listProviderProfiles: async () => storedProfiles,
		saveProviderProfile: async (input: Record<string, unknown>) => {
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
		updateProviderProfile: async (
			id: string,
			patch: Record<string, unknown>,
		) => {
			const index = storedProfiles.findIndex((profile) => profile.id === id);
			const updated = {
				...storedProfiles[index],
				...patch,
			} as ClientProviderProfileRecord;
			storedProfiles[index] = updated;
			return updated;
		},
		setCachedProviderModels: async (_id: string, models: unknown[]) => ({
			models,
			cachedAt: "now",
		}),
		resolveActiveProviderProfile: async () =>
			storedProfiles.find((profile) => profile.id === activeId) ?? null,
		activateProviderProfile: async (id: string) => {
			activeId = id;
			const profile = storedProfiles.find((item) => item.id === id)!;
			return { ...profile, isActive: true };
		},
		deleteProviderProfile: async (id: string) => {
			const index = storedProfiles.findIndex((profile) => profile.id === id);
			if (index >= 0) storedProfiles.splice(index, 1);
			if (activeId === id) activeId = null;
		},
	} as unknown as ProviderProfileService;
	return { profiles, storedProfiles };
}

function createConfiguredService(options: {
	profiles: ProviderProfileService;
	store: MemoryAiPassTokenStore;
	fetchImpl: typeof fetch;
}) {
	return new AiPassService({
		config: {
			clientId: "test-public-client",
			redirectUri:
				"https://localhost:48765/oauth/aipass/callback",
			appOrigin: "https://localhost:48765",
			prerequisite: null,
		},
		store: options.store,
		profiles: options.profiles,
		discovery: {
			get: async () => METADATA,
		} as unknown as AiPassDiscovery,
		fetchImpl: options.fetchImpl,
		now: () => 1_000,
	});
}

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
		const requests: Array<{
			url: string;
			body: string;
			contentType: string | null;
		}> = [];
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
			requests.push({
				url,
				body,
				contentType: new Headers(init?.headers).get("content-type"),
			});
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
		const tokenRequest = requests.find((request) =>
			request.url === METADATA.tokenEndpoint,
		)!;
		expect(tokenRequest.contentType).toBe("application/json");
		expect(JSON.parse(tokenRequest.body)).toMatchObject({
			grantType: "authorization_code",
			clientId: "test-public-client",
			redirectUri:
				"https://localhost:48765/oauth/aipass/callback",
			code: "authorization-code",
			codeVerifier: expect.any(String),
		});
		expect(tokenRequest.body).not.toContain("clientSecret");

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

	test("serializes disconnect behind an in-progress OAuth completion", async () => {
		const { profiles, storedProfiles } = createProfileHarness();
		const store = new MemoryAiPassTokenStore();
		let signalTokenRequest: (() => void) | undefined;
		const tokenRequestStarted = new Promise<void>((resolve) => {
			signalTokenRequest = resolve;
		});
		let releaseTokenRequest: (() => void) | undefined;
		const tokenRequestGate = new Promise<void>((resolve) => {
			releaseTokenRequest = resolve;
		});
		const fetchImpl = (async (
			input: RequestInfo | URL,
		) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			if (url === METADATA.tokenEndpoint) {
				signalTokenRequest?.();
				await tokenRequestGate;
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
					data: [{
						id: "live-chat-model",
						methods: ["chat_completions"],
					}],
				});
			}
			if (url === METADATA.revocationEndpoint) {
				return new Response(null, { status: 200 });
			}
			throw new Error("Unexpected test request.");
		}) as unknown as typeof fetch;
		const service = createConfiguredService({
			profiles,
			store,
			fetchImpl,
		});
		const launch = await service.createAuthorizationLaunch();
		const started = await service.beginAuthorization(
			launch.launchPath.split("/").at(-1)!,
		);
		const state = new URL(started.authorizationUrl).searchParams.get(
			"state",
		)!;

		const completion = service.completeAuthorization({
			code: "authorization-code",
			state,
			transactionId: started.transactionId,
		});
		await tokenRequestStarted;
		const disconnect = service.disconnect();
		releaseTokenRequest?.();

		await completion;
		await disconnect;
		expect(await store.read()).toBeNull();
		expect(storedProfiles).toHaveLength(0);
		expect(await service.getStatus()).toMatchObject({
			connected: false,
			profileId: null,
		});
	});

	test("disconnect invalidates pending OAuth transactions", async () => {
		const { profiles } = createProfileHarness();
		const store = new MemoryAiPassTokenStore();
		const service = createConfiguredService({
			profiles,
			store,
			fetchImpl: (async () => {
				throw new Error("token exchange must not start");
			}) as unknown as typeof fetch,
		});
		const launch = await service.createAuthorizationLaunch();
		const started = await service.beginAuthorization(
			launch.launchPath.split("/").at(-1)!,
		);
		const state = new URL(started.authorizationUrl).searchParams.get(
			"state",
		)!;

		await service.disconnect();

		await expect(service.completeAuthorization({
			code: "authorization-code",
			state,
			transactionId: started.transactionId,
		})).rejects.toThrow("state validation");
	});

	for (const invalidResponse of [
		{
			name: "missing bearer token type",
			payload: {
				access_token: "server-access-token",
				refresh_token: "server-refresh-token",
				expires_in: 3_600,
			},
			expected: "token type",
		},
		{
			name: "missing initial refresh token",
			payload: {
				access_token: "server-access-token",
				token_type: "Bearer",
				expires_in: 3_600,
			},
			expected: "refresh token",
		},
	]) {
		test(`fails closed for a token response ${invalidResponse.name}`, async () => {
			const { profiles } = createProfileHarness();
			const store = new MemoryAiPassTokenStore();
			const revokedTokens: string[] = [];
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
				if (url === METADATA.tokenEndpoint) {
					return Response.json(invalidResponse.payload);
				}
				if (url === METADATA.userinfoEndpoint) {
					return Response.json({ sub: "account" });
				}
				if (url.includes("/oauth2/v1/models")) {
					return Response.json({ object: "list", data: [] });
				}
				if (url === METADATA.revocationEndpoint) {
					if (init?.body instanceof URLSearchParams) {
						const token = init.body.get("token");
						if (token) revokedTokens.push(token);
					}
					return new Response(null, { status: 200 });
				}
				throw new Error("Unexpected test request.");
			}) as unknown as typeof fetch;
			const service = createConfiguredService({
				profiles,
				store,
				fetchImpl,
			});
			const launch = await service.createAuthorizationLaunch();
			const started = await service.beginAuthorization(
				launch.launchPath.split("/").at(-1)!,
			);
			const state = new URL(started.authorizationUrl).searchParams.get(
				"state",
			)!;

			await expect(service.completeAuthorization({
				code: "authorization-code",
				state,
				transactionId: started.transactionId,
			})).rejects.toThrow(invalidResponse.expected);
			expect(await store.read()).toBeNull();
			expect(revokedTokens).toContain("server-access-token");
		});
	}

	test("removes a newly-created profile when connection setup rolls back", async () => {
		const harness = createProfileHarness();
		const profiles = {
			...harness.profiles,
			setCachedProviderModels: async () => {
				throw new Error("cache persistence failed");
			},
		} as ProviderProfileService;
		const store = new MemoryAiPassTokenStore();
		const fetchImpl = (async (
			input: RequestInfo | URL,
		) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
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
					data: [{
						id: "live-chat-model",
						methods: ["chat_completions"],
					}],
				});
			}
			if (url === METADATA.revocationEndpoint) {
				return new Response(null, { status: 200 });
			}
			throw new Error("Unexpected test request.");
		}) as unknown as typeof fetch;
		const service = createConfiguredService({
			profiles,
			store,
			fetchImpl,
		});
		const launch = await service.createAuthorizationLaunch();
		const started = await service.beginAuthorization(
			launch.launchPath.split("/").at(-1)!,
		);
		const state = new URL(started.authorizationUrl).searchParams.get(
			"state",
		)!;

		await expect(service.completeAuthorization({
			code: "authorization-code",
			state,
			transactionId: started.transactionId,
		})).rejects.toThrow("cache persistence failed");

		expect(await store.read()).toBeNull();
		expect(harness.storedProfiles).toHaveLength(0);
	});
});
