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

	test("disconnect captures an in-flight rotation before clearing storage", async () => {
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
			accessToken: "rotated",
			refreshToken: "rotated-refresh",
		});
		expect(await store.read()).toBeNull();
	});

	test("rejects credential reads that start while disconnect is clearing storage", async () => {
		let tokens: AiPassTokenSet | null = {
			accessToken: "still-valid",
			refreshToken: "refresh",
			expiresAt: 3_600_000,
		};
		let releaseClear: (() => void) | undefined;
		const clearGate = new Promise<void>((resolve) => {
			releaseClear = resolve;
		});
		const store = {
			kind: "test",
			read: async () => tokens,
			write: async (next: AiPassTokenSet) => {
				tokens = next;
			},
			clear: async () => {
				await clearGate;
				tokens = null;
			},
		};
		const manager = new AiPassCredentialManager({
			store,
			now: () => 0,
			refresh: async () => {
				throw new Error("refresh must not run");
			},
		});

		const disconnectPromise = manager.takeAndClear();
		try {
			await expect(manager.getAccessToken()).rejects.toThrow(
				"connection changed",
			);
		} finally {
			releaseClear?.();
			await disconnectPromise;
		}
		expect(await store.read()).toBeNull();
	});

	test("rejects a rotated token when disconnect begins during secure persistence", async () => {
		let tokens: AiPassTokenSet | null = {
			accessToken: "expired",
			refreshToken: "refresh",
			expiresAt: 1,
		};
		let signalWriteStarted: (() => void) | undefined;
		const writeStarted = new Promise<void>((resolve) => {
			signalWriteStarted = resolve;
		});
		let releaseWrite: (() => void) | undefined;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const store = {
			kind: "test",
			read: async () => tokens,
			write: async (next: AiPassTokenSet) => {
				signalWriteStarted?.();
				await writeGate;
				tokens = next;
			},
			clear: async () => {
				tokens = null;
			},
		};
		const manager = new AiPassCredentialManager({
			store,
			now: () => 100_000,
			refresh: async () => ({
				accessToken: "rotated",
				refreshToken: "rotated-refresh",
				expiresAt: 3_700_000,
			}),
		});

		const accessPromise = manager.getAccessToken();
		await writeStarted;
		const disconnectPromise = manager.takeAndClear();
		releaseWrite?.();

		await expect(accessPromise).rejects.toThrow("connection changed");
		await disconnectPromise;
		expect(await store.read()).toBeNull();
	});

	test("rejects credential values that exceed the native-store bound", async () => {
		const store = new MemoryAiPassTokenStore();
		await expect(store.write({
			accessToken: "a".repeat(70 * 1024),
			refreshToken: "refresh",
			expiresAt: 3_600_000,
		})).rejects.toThrow("size limit");
	});
});
