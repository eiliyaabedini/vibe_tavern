import { describe, expect, test } from "bun:test";
import {
	AiPassCredentialManager,
	MemoryAiPassTokenStore,
	type AiPassTokenSet,
} from "../src/domain/aipass/aipass-credentials.js";

describe("AI Pass credential refresh", () => {
	test("serializes concurrent refreshes and atomically persists rotated tokens", async () => {
		const store = new MemoryAiPassTokenStore();
		const initial: AiPassTokenSet = {
			accessToken: "expired-access",
			refreshToken: "old-refresh",
			expiresAt: 1_000,
		};
		await store.write(initial);

		let refreshCalls = 0;
		const manager = new AiPassCredentialManager({
			store,
			now: () => 2_000,
			refresh: async (refreshToken) => {
				refreshCalls += 1;
				expect(refreshToken).toBe("old-refresh");
				await Promise.resolve();
				return {
					accessToken: "rotated-access",
					refreshToken: "rotated-refresh",
					expiresAt: 3_602_000,
				};
			},
		});

		const tokens = await Promise.all([
			manager.getAccessToken(),
			manager.getAccessToken(),
			manager.getAccessToken(),
		]);

		expect(tokens).toEqual([
			"rotated-access",
			"rotated-access",
			"rotated-access",
		]);
		expect(refreshCalls).toBe(1);
		expect(await store.read()).toEqual({
			accessToken: "rotated-access",
			refreshToken: "rotated-refresh",
			expiresAt: 3_602_000,
		});
	});

	test("never returns a rotated token when atomic persistence fails", async () => {
		const initial: AiPassTokenSet = {
			accessToken: "expired-access",
			refreshToken: "refresh",
			expiresAt: 1,
		};
		const store = {
			read: async () => initial,
			write: async () => {
				throw new Error("secure storage unavailable");
			},
			clear: async () => {},
			kind: "test",
		};
		const manager = new AiPassCredentialManager({
			store,
			now: () => 100_000,
			refresh: async () => ({
				accessToken: "must-not-escape",
				refreshToken: "new-refresh",
				expiresAt: 200_000,
			}),
		});

		await expect(manager.getAccessToken()).rejects.toThrow(
			"secure storage unavailable",
		);
	});

	test("disconnect invalidates an in-flight refresh before clearing storage", async () => {
		const store = new MemoryAiPassTokenStore();
		await store.write({
			accessToken: "expired",
			refreshToken: "refresh",
			expiresAt: 1,
		});
		let releaseRefresh: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const manager = new AiPassCredentialManager({
			store,
			now: () => 100_000,
			refresh: async () => {
				await refreshGate;
				return {
					accessToken: "rotated",
					refreshToken: "rotated-refresh",
					expiresAt: 200_000,
				};
			},
		});

		const accessPromise = manager.getAccessToken();
		await Promise.resolve();
		const disconnectPromise = manager.takeAndClear();
		releaseRefresh?.();

		await expect(accessPromise).rejects.toThrow("connection changed");
		expect(await disconnectPromise).toMatchObject({
			accessToken: "expired",
		});
		expect(await store.read()).toBeNull();
	});
});
