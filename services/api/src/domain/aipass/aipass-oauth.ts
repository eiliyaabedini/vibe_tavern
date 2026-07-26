const AI_PASS_SCOPES = "profile:read api:access";

export interface AiPassPkceTransaction {
	state: string;
	codeVerifier: string;
	codeChallenge: string;
}

export interface AiPassAuthorizationUrlInput {
	authorizationEndpoint: string;
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}

function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64Url(bytes: ArrayBuffer): string {
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export async function createAiPassPkceTransaction(): Promise<AiPassPkceTransaction> {
	const state = randomBase64Url(32);
	const codeVerifier = randomBase64Url(64);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(codeVerifier),
	);
	return {
		state,
		codeVerifier,
		codeChallenge: base64Url(digest),
	};
}

export function createOpaqueAiPassId(): string {
	return randomBase64Url(32);
}

export function buildAiPassAuthorizationUrl(
	input: AiPassAuthorizationUrlInput,
): URL {
	const url = new URL(input.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("scope", AI_PASS_SCOPES);
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url;
}
