import { Hono } from "hono";
import {
	deleteCookie,
	getCookie,
	setCookie,
} from "hono/cookie";
import type {
	AiPassCallbackInput,
	AiPassStatus,
} from "../../domain/aipass/aipass-service.js";

const TRANSACTION_COOKIE = "__Host-vibe-tavern-aipass";
const MAX_CODE_LENGTH = 4_096;
const MAX_STATE_LENGTH = 256;
const MAX_ERROR_LENGTH = 256;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AiPassRouteRuntime {
	readonly appOrigin: string | null;
	getStatus(): Promise<AiPassStatus>;
	createAuthorizationLaunch(): Promise<{ launchPath: string }>;
	beginAuthorization(
		launchId: string,
	): Promise<{ authorizationUrl: string; transactionId: string }>;
	completeAuthorization(input: AiPassCallbackInput): Promise<void>;
	disconnect(): Promise<{ revoked: boolean }>;
}

function trustedOrigin(
	origin: string | undefined,
	expected: string | null,
): boolean {
	return expected !== null && origin === expected;
}

function bounded(value: string | undefined, maxLength: number): string {
	return typeof value === "string" && value.length <= maxLength
		? value
		: "";
}

function callbackHtml(origin: string, ok: boolean, nonce: string): string {
	const targetOrigin = JSON.stringify(origin);
	const payload = JSON.stringify({
		type: "vibe-tavern:aipass-oauth",
		ok,
	});
	const title = ok ? "AI Pass connected" : "AI Pass connection failed";
	const message = ok
		? "AI Pass is connected. You can close this window."
		: "The AI Pass connection was not completed. You can close this window and try again.";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${message}</p>
</main>
<script nonce="${nonce}">
if (window.opener) {
	window.opener.postMessage(${payload}, ${targetOrigin});
	window.setTimeout(() => window.close(), 100);
}
</script>
</body>
</html>`;
}

export function createAiPassRoutes(runtime: AiPassRouteRuntime) {
	return new Hono()
		.get("/api/aipass/status", async (c) => {
			c.header("Cache-Control", "no-store");
			return c.json(await runtime.getStatus());
		})
		.post("/api/aipass/start", async (c) => {
			if (!trustedOrigin(c.req.header("Origin"), runtime.appOrigin)) {
				return c.json(
					{
						error: {
							kind: "Forbidden",
							message: "AI Pass connection must start same-origin.",
						},
					},
					403,
				);
			}
			c.header("Access-Control-Allow-Origin", runtime.appOrigin!);
			c.header("Vary", "Origin");
			c.header("Cache-Control", "no-store");
			return c.json(await runtime.createAuthorizationLaunch());
		})
		.get("/oauth/aipass/start/:launchId", async (c) => {
			const launchId = c.req.param("launchId");
			if (!OPAQUE_ID_PATTERN.test(launchId)) {
				return c.text("AI Pass connection launch is invalid.", 400);
			}
			const started = await runtime.beginAuthorization(launchId);
			setCookie(c, TRANSACTION_COOKIE, started.transactionId, {
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
				path: "/",
				maxAge: 10 * 60,
			});
			c.header("Cache-Control", "no-store");
			c.header("Referrer-Policy", "no-referrer");
			return c.redirect(started.authorizationUrl, 302);
		})
		.get("/oauth/aipass/callback", async (c) => {
			const code = bounded(
				c.req.query("code"),
				MAX_CODE_LENGTH,
			);
			const state = bounded(
				c.req.query("state"),
				MAX_STATE_LENGTH,
			);
			const oauthError = bounded(
				c.req.query("error"),
				MAX_ERROR_LENGTH,
			);
			const transactionId =
				getCookie(c, TRANSACTION_COOKIE) ?? "";
			let ok = false;
			try {
				await runtime.completeAuthorization({
					code,
					state,
					transactionId,
					...(oauthError ? { oauthError } : {}),
				});
				ok = true;
			} catch {
				ok = false;
			}
			deleteCookie(c, TRANSACTION_COOKIE, {
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
				path: "/",
			});
			const nonce = crypto.randomUUID().replace(/-/g, "");
			c.header("Cache-Control", "no-store");
			c.header("Pragma", "no-cache");
			c.header("Referrer-Policy", "no-referrer");
			c.header("X-Content-Type-Options", "nosniff");
			c.header(
				"Content-Security-Policy",
				`default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
			);
			return c.html(
				callbackHtml(
					runtime.appOrigin ?? "https://invalid.local",
					ok,
					nonce,
				),
			);
		})
		.post("/api/aipass/disconnect", async (c) => {
			if (!trustedOrigin(c.req.header("Origin"), runtime.appOrigin)) {
				return c.json(
					{
						error: {
							kind: "Forbidden",
							message: "AI Pass disconnect must be same-origin.",
						},
					},
					403,
				);
			}
			c.header("Access-Control-Allow-Origin", runtime.appOrigin!);
			c.header("Vary", "Origin");
			c.header("Cache-Control", "no-store");
			return c.json(await runtime.disconnect());
		});
}
