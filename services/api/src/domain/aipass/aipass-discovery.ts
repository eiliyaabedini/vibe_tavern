import {
	AIPASS_DISCOVERY_URL,
	AIPASS_ISSUER,
	fetchAiPassBoundedJson,
} from "./aipass-transport.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_BYTES = 64 * 1024;
const DISCOVERY_CACHE_MS = 60 * 60 * 1_000;

export interface AiPassAuthorizationServerMetadata {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	userinfoEndpoint: string;
	revocationEndpoint: string;
}

interface AiPassDiscoveryOptions {
	fetchImpl?: typeof fetch;
	now?: () => number;
}

function endpoint(
	record: Record<string, unknown>,
	field: string,
): string {
	const value = record[field];
	if (typeof value !== "string") {
		throw new Error("AI Pass authorization-server metadata is incomplete.");
	}
	const url = new URL(value);
	if (url.protocol !== "https:" || url.origin !== AIPASS_ISSUER) {
		throw new Error("AI Pass authorization-server metadata is invalid.");
	}
	return url.href;
}

function requiresMetadataValue(
	record: Record<string, unknown>,
	field: string,
	required: string,
): void {
	const value = record[field];
	if (
		!Array.isArray(value) ||
		!value.some((item) => item === required)
	) {
		throw new Error(
			"AI Pass authorization-server metadata lacks a required capability.",
		);
	}
}

export class AiPassDiscovery {
	private readonly fetchImpl?: typeof fetch;
	private readonly now: () => number;
	private cache:
		| {
				value: AiPassAuthorizationServerMetadata;
				expiresAt: number;
		  }
		| undefined;

	constructor(options: AiPassDiscoveryOptions = {}) {
		this.fetchImpl = options.fetchImpl;
		this.now = options.now ?? Date.now;
	}

	async get(
		signal?: AbortSignal,
	): Promise<AiPassAuthorizationServerMetadata> {
		if (this.cache && this.cache.expiresAt > this.now()) {
			return this.cache.value;
		}
		const { payload } = await fetchAiPassBoundedJson(
			AIPASS_DISCOVERY_URL,
			{
				fetchImpl: this.fetchImpl,
				operation: "AI Pass authorization discovery",
				timeoutMs: DISCOVERY_TIMEOUT_MS,
				maxResponseBytes: DISCOVERY_MAX_BYTES,
				signal,
				request: {
					method: "GET",
					headers: { Accept: "application/json" },
				},
			},
		);
		if (!payload || typeof payload !== "object") {
			throw new Error("AI Pass authorization-server metadata is invalid.");
		}
		const record = payload as Record<string, unknown>;
		if (record.issuer !== AIPASS_ISSUER) {
			throw new Error("AI Pass authorization-server issuer did not match.");
		}
		requiresMetadataValue(
			record,
			"response_types_supported",
			"code",
		);
		requiresMetadataValue(
			record,
			"grant_types_supported",
			"authorization_code",
		);
		requiresMetadataValue(
			record,
			"grant_types_supported",
			"refresh_token",
		);
		requiresMetadataValue(
			record,
			"code_challenge_methods_supported",
			"S256",
		);
		requiresMetadataValue(
			record,
			"token_endpoint_auth_methods_supported",
			"none",
		);
		requiresMetadataValue(
			record,
			"scopes_supported",
			"profile:read",
		);
		requiresMetadataValue(
			record,
			"scopes_supported",
			"api:access",
		);
		const value: AiPassAuthorizationServerMetadata = {
			issuer: AIPASS_ISSUER,
			authorizationEndpoint: endpoint(
				record,
				"authorization_endpoint",
			),
			tokenEndpoint: endpoint(record, "token_endpoint"),
			userinfoEndpoint: endpoint(record, "userinfo_endpoint"),
			revocationEndpoint: endpoint(record, "revocation_endpoint"),
		};
		this.cache = {
			value,
			expiresAt: this.now() + DISCOVERY_CACHE_MS,
		};
		return value;
	}
}
