export const AIPASS_CLIENT_ID_ENV = "VIBE_TAVERN_AIPASS_CLIENT_ID";
export const AIPASS_REDIRECT_URI_ENV =
	"VIBE_TAVERN_AIPASS_REDIRECT_URI";

export interface AiPassConfig {
	readonly clientId: string | null;
	readonly redirectUri: string | null;
	readonly appOrigin: string | null;
	readonly prerequisite: string | null;
}

export function resolveAiPassConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): AiPassConfig {
	const clientId = env[AIPASS_CLIENT_ID_ENV]?.trim() ?? "";
	const redirectValue = env[AIPASS_REDIRECT_URI_ENV]?.trim() ?? "";
	if (!clientId || !redirectValue) {
		return {
			clientId: null,
			redirectUri: null,
			appOrigin: null,
			prerequisite:
				"Protected AI Pass client configuration and a registered HTTPS callback are required.",
		};
	}
	if (clientId.length > 512 || redirectValue.length > 2_048) {
		return {
			clientId: null,
			redirectUri: null,
			appOrigin: null,
			prerequisite: "AI Pass runtime configuration is invalid.",
		};
	}

	let redirect: URL;
	try {
		redirect = new URL(redirectValue);
	} catch {
		return {
			clientId: null,
			redirectUri: null,
			appOrigin: null,
			prerequisite: "The AI Pass callback URI is invalid.",
		};
	}
	if (
		redirect.protocol !== "https:" ||
		redirect.username ||
		redirect.password ||
		redirect.search ||
		redirect.hash ||
		redirect.pathname !== "/oauth/aipass/callback"
	) {
		return {
			clientId: null,
			redirectUri: null,
			appOrigin: null,
			prerequisite:
				"AI Pass requires a registered HTTPS /oauth/aipass/callback URI.",
		};
	}
	return {
		clientId,
		redirectUri: redirect.href,
		appOrigin: redirect.origin,
		prerequisite: null,
	};
}
