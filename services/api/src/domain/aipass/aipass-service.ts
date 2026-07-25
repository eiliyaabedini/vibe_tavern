import { timingSafeEqual } from "node:crypto";
import type { ProviderModelOption } from "../providers/provider-transport.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import type {
	AiPassCredentialManager,
	AiPassTokenSet,
	AiPassTokenStore,
} from "./aipass-credentials.js";
import { AiPassCredentialManager as CredentialManager } from "./aipass-credentials.js";
import type { AiPassConfig } from "./aipass-config.js";
import {
	AiPassDiscovery,
	type AiPassAuthorizationServerMetadata,
} from "./aipass-discovery.js";
import { parseAiPassModels } from "./aipass-models.js";
import {
	buildAiPassAuthorizationUrl,
	createAiPassPkceTransaction,
	createOpaqueAiPassId,
} from "./aipass-oauth.js";
import {
	AIPASS_API_BASE_URL,
	AIPASS_MODELS_URL,
	fetchAiPassBoundedJson,
} from "./aipass-transport.js";

const AI_PASS_PRESET = "aipass";
const LAUNCH_TTL_MS = 60_000;
const TRANSACTION_TTL_MS = 10 * 60_000;
const MAX_PENDING_ITEMS = 32;
const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_MAX_BYTES = 128 * 1024;
const USERINFO_MAX_BYTES = 128 * 1024;
const MODELS_MAX_BYTES = 2 * 1024 * 1024;

interface PendingLaunch {
	expiresAt: number;
}

interface PendingTransaction {
	state: string;
	codeVerifier: string;
	expiresAt: number;
}

interface AiPassServiceOptions {
	config: AiPassConfig;
	store: AiPassTokenStore;
	profiles: ProviderProfileService;
	discovery?: AiPassDiscovery;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface AiPassStatus {
	available: boolean;
	connected: boolean;
	profileId: string | null;
	storage: string;
	prerequisite: string | null;
}

export interface AiPassCallbackInput {
	code: string;
	state: string;
	transactionId: string;
	oauthError?: string;
}

function requireString(
	record: Record<string, unknown>,
	field: string,
): string {
	const value = record[field];
	if (typeof value !== "string" || !value) {
		throw new Error("AI Pass token response was incomplete.");
	}
	return value;
}

function sameOpaqueValue(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return (
		leftBytes.length === rightBytes.length &&
		timingSafeEqual(leftBytes, rightBytes)
	);
}

export class AiPassService {
	readonly appOrigin: string | null;
	readonly credentials: AiPassCredentialManager;
	private readonly config: AiPassConfig;
	private readonly profiles: ProviderProfileService;
	private readonly discovery: AiPassDiscovery;
	private readonly fetchImpl?: typeof fetch;
	private readonly now: () => number;
	private readonly launches = new Map<string, PendingLaunch>();
	private readonly transactions = new Map<string, PendingTransaction>();
	private lifecycleTail: Promise<void> = Promise.resolve();

	constructor(options: AiPassServiceOptions) {
		this.config = options.config;
		this.appOrigin = options.config.appOrigin;
		this.profiles = options.profiles;
		this.discovery = options.discovery ?? new AiPassDiscovery({
			fetchImpl: options.fetchImpl,
			now: options.now,
		});
		this.fetchImpl = options.fetchImpl;
		this.now = options.now ?? Date.now;
		this.credentials = new CredentialManager({
			store: options.store,
			now: this.now,
			refresh: (refreshToken, signal) =>
				this.refreshTokens(refreshToken, signal),
		});
	}

	async getStatus(): Promise<AiPassStatus> {
		let connected = false;
		try {
			connected = (await this.credentials.read()) !== null;
		} catch {
			return {
				available: false,
				connected: false,
				profileId: null,
				storage: this.credentials.storageKind,
				prerequisite:
					"The operating-system credential store is unavailable.",
			};
		}
		const profiles = await this.profiles.listProviderProfiles();
		const profile =
			profiles.find((candidate) =>
				candidate.providerPreset === AI_PASS_PRESET,
			) ?? null;
		return {
			available: this.config.prerequisite === null,
			connected,
			profileId: profile?.id ?? null,
			storage: this.credentials.storageKind,
			prerequisite: this.config.prerequisite,
		};
	}

	async createAuthorizationLaunch(): Promise<{ launchPath: string }> {
		this.requireConfiguration();
		this.prune();
		if (this.launches.size >= MAX_PENDING_ITEMS) {
			throw new Error("Too many pending AI Pass connection attempts.");
		}
		const id = createOpaqueAiPassId();
		this.launches.set(id, { expiresAt: this.now() + LAUNCH_TTL_MS });
		return { launchPath: `/oauth/aipass/start/${id}` };
	}

	async beginAuthorization(
		launchId: string,
	): Promise<{ authorizationUrl: string; transactionId: string }> {
		const config = this.requireConfiguration();
		this.prune();
		const launch = this.launches.get(launchId);
		this.launches.delete(launchId);
		if (!launch || launch.expiresAt <= this.now()) {
			throw new Error("AI Pass connection launch expired.");
		}
		if (this.transactions.size >= MAX_PENDING_ITEMS) {
			throw new Error("Too many pending AI Pass connection attempts.");
		}

		const metadata = await this.discovery.get();
		const pkce = await createAiPassPkceTransaction();
		const transactionId = createOpaqueAiPassId();
		this.transactions.set(transactionId, {
			state: pkce.state,
			codeVerifier: pkce.codeVerifier,
			expiresAt: this.now() + TRANSACTION_TTL_MS,
		});
		const authorizationUrl = buildAiPassAuthorizationUrl({
			authorizationEndpoint: metadata.authorizationEndpoint,
			clientId: config.clientId,
			redirectUri: config.redirectUri,
			state: pkce.state,
			codeChallenge: pkce.codeChallenge,
		});
		return {
			authorizationUrl: authorizationUrl.href,
			transactionId,
		};
	}

	async completeAuthorization(input: AiPassCallbackInput): Promise<void> {
		const config = this.requireConfiguration();
		this.prune();
		const transaction = this.transactions.get(input.transactionId);
		this.transactions.delete(input.transactionId);
		if (
			!transaction ||
			transaction.expiresAt <= this.now() ||
			!sameOpaqueValue(transaction.state, input.state)
		) {
			throw new Error("AI Pass OAuth state validation failed.");
		}
		if (input.oauthError) {
			throw new Error("AI Pass authorization was not completed.");
		}
		if (!input.code) {
			throw new Error("AI Pass authorization code was missing.");
		}

		await this.runLifecycle(async () => {
			const metadata = await this.discovery.get();
			const previous = await this.credentials.read();
			const tokens = await this.exchangeCode(
				metadata,
				config.clientId,
				config.redirectUri,
				input.code,
				transaction.codeVerifier,
			);
			let stored = false;
			try {
				await this.validateUserinfo(metadata, tokens.accessToken);
				const models = await this.fetchModels(tokens.accessToken);
				await this.credentials.write(tokens);
				stored = true;
				await this.ensureProfile(models);
			} catch (error) {
				await this.revokeTokens(metadata, tokens).catch(() => {});
				if (stored) {
					if (previous) await this.credentials.write(previous);
					else await this.credentials.clear();
				}
				throw error;
			}
		});
	}

	async disconnect(): Promise<{ revoked: boolean }> {
		this.launches.clear();
		this.transactions.clear();
		return this.runLifecycle(async () => {
			const tokens = await this.credentials.takeAndClear();
			let revoked = tokens === null;
			if (tokens) {
				try {
					const metadata = await this.discovery.get();
					await this.revokeTokens(metadata, tokens);
					revoked = true;
				} catch {
					revoked = false;
				}
			}
			const profiles = await this.profiles.listProviderProfiles();
			for (const profile of profiles) {
				if (profile.providerPreset === AI_PASS_PRESET) {
					await this.profiles.deleteProviderProfile(profile.id);
				}
			}
			return { revoked };
		});
	}

	private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.lifecycleTail.then(operation);
		this.lifecycleTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private requireConfiguration(): {
		clientId: string;
		redirectUri: string;
	} {
		if (
			this.config.prerequisite ||
			!this.config.clientId ||
			!this.config.redirectUri
		) {
			throw new Error(
				this.config.prerequisite ??
					"AI Pass protected runtime configuration is unavailable.",
			);
		}
		return {
			clientId: this.config.clientId,
			redirectUri: this.config.redirectUri,
		};
	}

	private prune(): void {
		const now = this.now();
		for (const [id, launch] of this.launches) {
			if (launch.expiresAt <= now) this.launches.delete(id);
		}
		for (const [id, transaction] of this.transactions) {
			if (transaction.expiresAt <= now) this.transactions.delete(id);
		}
	}

	private async requestTokens(
		metadata: AiPassAuthorizationServerMetadata,
		body: Record<string, string>,
		signal?: AbortSignal,
		requireRefreshToken = false,
	): Promise<AiPassTokenSet> {
		const { payload } = await fetchAiPassBoundedJson(
			metadata.tokenEndpoint,
			{
				fetchImpl: this.fetchImpl,
				operation: "AI Pass token request",
				timeoutMs: TOKEN_TIMEOUT_MS,
				maxResponseBytes: TOKEN_MAX_BYTES,
				signal,
				request: {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
					},
					// AI Pass's first-party public-client protocol currently
					// accepts JSON camelCase token requests. Endpoints still
					// come exclusively from validated discovery metadata.
					body: JSON.stringify(body),
				},
			},
		);
		if (!payload || typeof payload !== "object") {
			throw new Error("AI Pass token response was invalid.");
		}
		const record = payload as Record<string, unknown>;
		const accessToken = requireString(record, "access_token");
		const refreshToken =
			typeof record.refresh_token === "string" &&
			record.refresh_token
				? record.refresh_token
				: undefined;
		const provisionalTokens: AiPassTokenSet = {
			accessToken,
			...(refreshToken ? { refreshToken } : {}),
			expiresAt: this.now(),
		};
		try {
			const tokenType =
				typeof record.token_type === "string"
					? record.token_type.toLowerCase()
					: "";
			if (tokenType !== "bearer") {
				throw new Error(
					"AI Pass token type was missing or unsupported.",
				);
			}
			const expiresIn =
				typeof record.expires_in === "string" &&
				/^\d+$/.test(record.expires_in)
					? Number(record.expires_in)
					: record.expires_in;
			if (
				typeof expiresIn !== "number" ||
				!Number.isFinite(expiresIn) ||
				expiresIn <= 0 ||
				expiresIn > 31 * 24 * 60 * 60
			) {
				throw new Error("AI Pass token expiry was invalid.");
			}
			const scope =
				typeof record.scope === "string" ? record.scope : undefined;
			if (scope) {
				const scopes = new Set(scope.split(/\s+/).filter(Boolean));
				if (
					!scopes.has("profile:read") ||
					!scopes.has("api:access")
				) {
					throw new Error(
						"AI Pass did not grant the required scopes.",
					);
				}
			}
			if (requireRefreshToken && !refreshToken) {
				throw new Error(
					"AI Pass token response was missing a refresh token.",
				);
			}
			return {
				accessToken,
				...(refreshToken ? { refreshToken } : {}),
				expiresAt: this.now() + expiresIn * 1_000,
				...(scope ? { scope } : {}),
			};
		} catch (error) {
			await this.revokeTokens(metadata, provisionalTokens).catch(() => {});
			throw error;
		}
	}

	private async exchangeCode(
		metadata: AiPassAuthorizationServerMetadata,
		clientId: string,
		redirectUri: string,
		code: string,
		codeVerifier: string,
	): Promise<AiPassTokenSet> {
		return this.requestTokens(
			metadata,
			{
				grantType: "authorization_code",
				clientId,
				redirectUri,
				code,
				codeVerifier,
			},
			undefined,
			true,
		);
	}

	private async refreshTokens(
		refreshToken: string,
		signal?: AbortSignal,
	): Promise<AiPassTokenSet> {
		const config = this.requireConfiguration();
		const metadata = await this.discovery.get(signal);
		return this.requestTokens(
			metadata,
			{
				grantType: "refresh_token",
				clientId: config.clientId,
				refreshToken,
			},
			signal,
		);
	}

	private async validateUserinfo(
		metadata: AiPassAuthorizationServerMetadata,
		accessToken: string,
	): Promise<void> {
		const { payload } = await fetchAiPassBoundedJson(
			metadata.userinfoEndpoint,
			{
				fetchImpl: this.fetchImpl,
				operation: "AI Pass user information request",
				timeoutMs: TOKEN_TIMEOUT_MS,
				maxResponseBytes: USERINFO_MAX_BYTES,
				request: {
					method: "GET",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${accessToken}`,
					},
				},
			},
		);
		if (!payload || typeof payload !== "object") {
			throw new Error("AI Pass user information response was invalid.");
		}
	}

	private async fetchModels(
		accessToken: string,
	): Promise<ProviderModelOption[]> {
		const { payload } = await fetchAiPassBoundedJson(
			AIPASS_MODELS_URL,
			{
				fetchImpl: this.fetchImpl,
				operation: "AI Pass model discovery",
				timeoutMs: TOKEN_TIMEOUT_MS,
				maxResponseBytes: MODELS_MAX_BYTES,
				request: {
					method: "GET",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${accessToken}`,
					},
				},
			},
		);
		return parseAiPassModels(payload);
	}

	private async ensureProfile(
		models: ProviderModelOption[],
	): Promise<void> {
		const profiles = await this.profiles.listProviderProfiles();
		const matches = profiles.filter(
			(profile) => profile.providerPreset === AI_PASS_PRESET,
		);
		if (matches.length > 1) {
			throw new Error(
				"Multiple AI Pass profiles exist; disconnect before reconnecting.",
			);
		}
		const existing = matches[0];
		const modelIds = new Set(models.map((model) => model.id));
		const defaultModel =
			existing?.defaultModel && modelIds.has(existing.defaultModel)
				? existing.defaultModel
				: models[0]?.id ?? null;
		const visionModels = models.filter(
			(model) => model.capabilities?.vision,
		);
		const visionModel =
			existing?.visionModel && modelIds.has(existing.visionModel)
				? existing.visionModel
				: visionModels[0]?.id ?? null;

		let createdProfileId: string | null = null;
		try {
			const profile = existing
				? await this.profiles.updateProviderProfile(existing.id, {
						endpoint: AIPASS_API_BASE_URL,
						providerPreset: AI_PASS_PRESET,
						apiKey: null,
						defaultModel,
						visionModel,
					})
				: await this.profiles.saveProviderProfile({
						name: "AI Pass",
						providerPreset: AI_PASS_PRESET,
						endpoint: AIPASS_API_BASE_URL,
						apiKey: null,
						defaultModel,
						visionModel,
						streamResponse: true,
					});
			if (!existing) createdProfileId = profile.id;

			await this.profiles.setCachedProviderModels(
				profile.id,
				models.map((model) => ({
					id: model.id,
					label: model.label,
					...(model.contextLength !== undefined
						? { contextLength: model.contextLength }
						: {}),
					...(model.capabilities
						? {
							capabilities: {
								thinking: model.capabilities.reasoning,
								tools: model.capabilities.tools,
								vision: model.capabilities.vision,
							},
						}
						: {}),
				})),
			);
			if (!(await this.profiles.resolveActiveProviderProfile())) {
				await this.profiles.activateProviderProfile(profile.id);
			}
		} catch (error) {
			if (createdProfileId) {
				try {
					await this.profiles.deleteProviderProfile(createdProfileId);
				} catch {
					throw new Error(
						"AI Pass profile setup failed and rollback could not remove the incomplete profile.",
					);
				}
			}
			throw error;
		}
	}

	private async revokeTokens(
		metadata: AiPassAuthorizationServerMetadata,
		tokens: AiPassTokenSet,
	): Promise<void> {
		const tokenValues = [
			tokens.accessToken,
			...(tokens.refreshToken ? [tokens.refreshToken] : []),
		];
		let failed = false;
		for (const token of new Set(tokenValues)) {
			const params = new URLSearchParams({ token });
			if (this.config.clientId) {
				params.set("client_id", this.config.clientId);
			}
			try {
				await fetchAiPassBoundedJson(metadata.revocationEndpoint, {
					fetchImpl: this.fetchImpl,
					operation: "AI Pass token revocation",
					timeoutMs: TOKEN_TIMEOUT_MS,
					maxResponseBytes: TOKEN_MAX_BYTES,
					request: {
						method: "POST",
						headers: {
							Accept: "application/json",
							"Content-Type":
								"application/x-www-form-urlencoded",
						},
						body: params,
					},
				});
			} catch {
				failed = true;
			}
		}
		if (failed) {
			throw new Error("One or more AI Pass tokens could not be revoked.");
		}
	}
}
