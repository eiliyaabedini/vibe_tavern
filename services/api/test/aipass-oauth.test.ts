import { describe, expect, test } from "bun:test";
import {
	buildAiPassAuthorizationUrl,
	createAiPassPkceTransaction,
} from "../src/domain/aipass/aipass-oauth.js";
import { resolveAiPassConfig } from "../src/domain/aipass/aipass-config.js";
import { AiPassDiscovery } from "../src/domain/aipass/aipass-discovery.js";

function base64Url(bytes: ArrayBuffer): string {
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

describe("AI Pass OAuth PKCE", () => {
	test("creates strong one-time state and an S256 verifier challenge", async () => {
		const first = await createAiPassPkceTransaction();
		const second = await createAiPassPkceTransaction();

		expect(first.state).not.toBe(second.state);
		expect(first.state.length).toBeGreaterThanOrEqual(43);
		expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);

		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(first.codeVerifier),
		);
		expect(first.codeChallenge).toBe(base64Url(digest));
	});

	test("builds a public-client authorization request without a client secret", () => {
		const url = buildAiPassAuthorizationUrl({
			authorizationEndpoint: "https://aipass.one/oauth2/authorize",
			clientId: "protected-runtime-value",
			redirectUri: "https://localhost:48765/oauth/aipass/callback",
			state: "state-value",
			codeChallenge: "challenge-value",
		});

		expect(url.origin).toBe("https://aipass.one");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("scope")).toBe("profile:read api:access");
		expect(url.searchParams.has("client_secret")).toBe(false);
	});

	test("fails closed unless the registered callback is HTTPS and exact", () => {
		expect(resolveAiPassConfig({
			VIBE_TAVERN_AIPASS_CLIENT_ID: "test-public-client",
			VIBE_TAVERN_AIPASS_REDIRECT_URI:
				"http://localhost:48765/oauth/aipass/callback",
		}).prerequisite).not.toBeNull();
		expect(resolveAiPassConfig({
			VIBE_TAVERN_AIPASS_CLIENT_ID: "test-public-client",
			VIBE_TAVERN_AIPASS_REDIRECT_URI:
				"https://localhost:48765/not-the-callback",
		}).prerequisite).not.toBeNull();
		expect(resolveAiPassConfig({
			VIBE_TAVERN_AIPASS_CLIENT_ID: "test-public-client",
			VIBE_TAVERN_AIPASS_REDIRECT_URI:
				"https://localhost:48765/oauth/aipass/callback",
		})).toMatchObject({
			appOrigin: "https://localhost:48765",
			prerequisite: null,
		});
	});

	test("requires S256 and public-client capabilities from discovery", async () => {
		const metadata = {
			issuer: "https://aipass.one",
			authorization_endpoint:
				"https://aipass.one/oauth2/authorize",
			token_endpoint: "https://aipass.one/oauth2/token",
			userinfo_endpoint: "https://aipass.one/oauth2/userinfo",
			revocation_endpoint: "https://aipass.one/oauth2/revoke",
			response_types_supported: ["code"],
			grant_types_supported: [
				"authorization_code",
				"refresh_token",
			],
			code_challenge_methods_supported: ["plain"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["profile:read", "api:access"],
		};
		const discovery = new AiPassDiscovery({
			fetchImpl: (async () =>
				Response.json(metadata)) as unknown as typeof fetch,
		});
		await expect(discovery.get()).rejects.toThrow(
			"required capability",
		);

		const validDiscovery = new AiPassDiscovery({
			fetchImpl: (async () =>
				Response.json({
					...metadata,
					code_challenge_methods_supported: ["S256"],
				})) as unknown as typeof fetch,
		});
		expect(await validDiscovery.get()).toMatchObject({
			issuer: "https://aipass.one",
			tokenEndpoint: "https://aipass.one/oauth2/token",
		});
	});
});
