import { describe, expect, test } from "bun:test";
import {
	createAiPassRoutes,
	type AiPassRouteRuntime,
} from "../src/api/routes/aipass.js";

const LAUNCH_ID = "a".repeat(43);

function mockRuntime(
	overrides: Partial<AiPassRouteRuntime> = {},
): AiPassRouteRuntime {
	return {
		appOrigin: "https://localhost:48765",
		getStatus: async () => ({
			available: true,
			connected: false,
			profileId: null,
			storage: "test",
			prerequisite: null,
		}),
		createAuthorizationLaunch: async () => ({
			launchPath: `/oauth/aipass/start/${LAUNCH_ID}`,
		}),
		beginAuthorization: async () => ({
			authorizationUrl:
				"https://aipass.one/oauth2/authorize?client_id=protected",
			transactionId: "opaque-transaction",
		}),
		completeAuthorization: async () => {},
		disconnect: async () => ({ revoked: true }),
		...overrides,
	};
}

describe("AI Pass OAuth routes", () => {
	test("starts through a same-origin one-time launch without returning OAuth configuration", async () => {
		const app = createAiPassRoutes(mockRuntime());
		const response = await app.request("/api/aipass/start", {
			method: "POST",
			headers: { Origin: "https://localhost:48765" },
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			launchPath: `/oauth/aipass/start/${LAUNCH_ID}`,
		});
		expect(JSON.stringify(body)).not.toContain("client_id");
		expect(JSON.stringify(body)).not.toContain("protected");
	});

	test("rejects cross-origin start requests", async () => {
		const app = createAiPassRoutes(mockRuntime());
		const response = await app.request("/api/aipass/start", {
			method: "POST",
			headers: { Origin: "https://attacker.example" },
		});

		expect(response.status).toBe(403);
	});

	test("redirects a one-time launch with a secure HttpOnly transaction cookie", async () => {
		const app = createAiPassRoutes(mockRuntime());
		const response = await app.request(
			`/oauth/aipass/start/${LAUNCH_ID}`,
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toStartWith(
			"https://aipass.one/oauth2/authorize",
		);
		const cookie = response.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).not.toContain("protected");
	});

	test("completes in a no-store, script-restricted page without reflecting secrets", async () => {
		let callbackInput: {
			code: string;
			state: string;
			transactionId: string;
		} | null = null;
		const app = createAiPassRoutes(mockRuntime({
			completeAuthorization: async (input) => {
				callbackInput = input;
			},
		}));
		const response = await app.request(
			"/oauth/aipass/callback?code=secret-code&state=secret-state",
			{
				headers: {
					Cookie:
						"__Host-vibe-tavern-aipass=opaque-transaction",
				},
			},
		);

		expect(response.status).toBe(200);
		expect(callbackInput).toEqual({
			code: "secret-code",
			state: "secret-state",
			transactionId: "opaque-transaction",
		});
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		const html = await response.text();
		expect(html).not.toContain("secret-code");
		expect(html).not.toContain("secret-state");
	});
});
