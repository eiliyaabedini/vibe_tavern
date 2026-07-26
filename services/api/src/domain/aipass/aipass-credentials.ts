import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const REFRESH_WINDOW_MS = 60_000;
const MAX_SECRET_BYTES = 64 * 1024;
const KEYCHAIN_SERVICE = "Vibe Tavern AI Pass OAuth";
const WINDOWS_SECRET_FILE = "aipass-oauth.dpapi";
const CREDENTIAL_OPERATION_TIMEOUT_MS = 15_000;

export interface AiPassTokenSet {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	scope?: string;
}

export interface AiPassTokenStore {
	readonly kind: string;
	read(): Promise<AiPassTokenSet | null>;
	write(tokens: AiPassTokenSet): Promise<void>;
	clear(): Promise<void>;
}

interface AiPassCredentialManagerOptions {
	store: AiPassTokenStore;
	refresh: (
		refreshToken: string,
		signal?: AbortSignal,
	) => Promise<AiPassTokenSet>;
	now?: () => number;
}

function validateTokens(value: unknown): AiPassTokenSet {
	if (!value || typeof value !== "object") {
		throw new Error("AI Pass secure storage contained invalid credentials.");
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.accessToken !== "string" ||
		!record.accessToken ||
		typeof record.expiresAt !== "number" ||
		!Number.isFinite(record.expiresAt)
	) {
		throw new Error("AI Pass secure storage contained invalid credentials.");
	}
	const tokens: AiPassTokenSet = {
		accessToken: record.accessToken,
		...(typeof record.refreshToken === "string" && record.refreshToken
			? { refreshToken: record.refreshToken }
			: {}),
		expiresAt: record.expiresAt,
		...(typeof record.scope === "string" ? { scope: record.scope } : {}),
	};
	if (Buffer.byteLength(JSON.stringify(tokens)) > MAX_SECRET_BYTES) {
		throw new Error("AI Pass secure storage value exceeded its size limit.");
	}
	return tokens;
}

function decodeStoredTokens(raw: string): AiPassTokenSet {
	if (Buffer.byteLength(raw) > MAX_SECRET_BYTES) {
		throw new Error("AI Pass secure storage value exceeded its size limit.");
	}
	try {
		return validateTokens(JSON.parse(raw));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("AI Pass secure storage contained invalid credentials.");
		}
		throw error;
	}
}

export class MemoryAiPassTokenStore implements AiPassTokenStore {
	readonly kind = "memory";
	private tokens: AiPassTokenSet | null = null;

	async read(): Promise<AiPassTokenSet | null> {
		return this.tokens ? { ...this.tokens } : null;
	}

	async write(tokens: AiPassTokenSet): Promise<void> {
		this.tokens = { ...validateTokens(tokens) };
	}

	async clear(): Promise<void> {
		this.tokens = null;
	}
}

export class AiPassCredentialManager {
	private readonly store: AiPassTokenStore;
	private readonly refresh: AiPassCredentialManagerOptions["refresh"];
	private readonly now: () => number;
	private refreshInFlight: Promise<string> | null = null;
	private revision = 0;
	private changesInFlight = 0;

	constructor(options: AiPassCredentialManagerOptions) {
		this.store = options.store;
		this.refresh = options.refresh;
		this.now = options.now ?? Date.now;
	}

	get storageKind(): string {
		return this.store.kind;
	}

	read(): Promise<AiPassTokenSet | null> {
		return this.store.read();
	}

	async write(tokens: AiPassTokenSet): Promise<void> {
		this.revision += 1;
		this.changesInFlight += 1;
		try {
			await this.refreshInFlight?.catch(() => {});
			await this.store.write(validateTokens(tokens));
		} finally {
			this.changesInFlight -= 1;
		}
	}

	async clear(): Promise<void> {
		this.revision += 1;
		this.changesInFlight += 1;
		try {
			await this.refreshInFlight?.catch(() => {});
			await this.store.clear();
		} finally {
			this.changesInFlight -= 1;
		}
	}

	async takeAndClear(): Promise<AiPassTokenSet | null> {
		this.revision += 1;
		this.changesInFlight += 1;
		try {
			await this.refreshInFlight?.catch(() => {});
			const tokens = await this.store.read();
			await this.store.clear();
			return tokens;
		} finally {
			this.changesInFlight -= 1;
		}
	}

	async getAccessToken(signal?: AbortSignal): Promise<string> {
		if (this.changesInFlight > 0) {
			throw new Error("AI Pass connection changed during credential access.");
		}
		const revision = this.revision;
		const tokens = await this.store.read();
		if (
			revision !== this.revision ||
			this.changesInFlight > 0
		) {
			throw new Error("AI Pass connection changed during credential access.");
		}
		if (!tokens) throw new Error("AI Pass is not connected.");
		if (tokens.expiresAt > this.now() + REFRESH_WINDOW_MS) {
			return tokens.accessToken;
		}
		if (!tokens.refreshToken) {
			throw new Error("AI Pass connection expired. Reconnect AI Pass.");
		}
		if (!this.refreshInFlight) {
			this.refreshInFlight = this.rotate(
				tokens,
				revision,
				signal,
			).finally(() => {
				this.refreshInFlight = null;
			});
		}
		return this.refreshInFlight;
	}

	private async rotate(
		current: AiPassTokenSet,
		revision: number,
		signal?: AbortSignal,
	): Promise<string> {
		const refreshed = await this.refresh(current.refreshToken!, signal);
		const rotated: AiPassTokenSet = {
			...refreshed,
			refreshToken: refreshed.refreshToken ?? current.refreshToken,
		};
		// Persist before the revision check so a waiting disconnect can retrieve
		// and revoke credentials that the authorization server already rotated.
		await this.store.write(rotated);
		if (revision !== this.revision) {
			throw new Error("AI Pass connection changed during token refresh.");
		}
		return rotated.accessToken;
	}
}

async function instanceAccount(dataDir: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(resolve(dataDir)),
	);
	return Buffer.from(digest).toString("hex");
}

async function readBoundedStdout(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_SECRET_BYTES) {
				await reader.cancel();
				throw new Error("AI Pass secure storage value exceeded its size limit.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function waitForCredentialProcess(
	proc: { exited: Promise<number>; kill(): void },
): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			proc.exited,
			new Promise<number>((_resolve, reject) => {
				timer = setTimeout(() => {
					proc.kill();
					reject(
						new Error("AI Pass credential-store operation timed out."),
					);
				}, CREDENTIAL_OPERATION_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

class MacOsKeychainAiPassTokenStore implements AiPassTokenStore {
	readonly kind = "macos-keychain";

	constructor(private readonly account: string) {}

	async read(): Promise<AiPassTokenSet | null> {
		const proc = Bun.spawn(
			[
				"/usr/bin/security",
				"find-generic-password",
				"-a",
				this.account,
				"-s",
				KEYCHAIN_SERVICE,
				"-w",
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
		);
		const outputPromise = readBoundedStdout(proc.stdout);
		const [exitCode, output] = await Promise.all([
			waitForCredentialProcess(proc),
			outputPromise,
		]);
		if (exitCode === 44) return null;
		if (exitCode !== 0) {
			throw new Error("AI Pass macOS Keychain access failed.");
		}
		return decodeStoredTokens(output);
	}

	async write(tokens: AiPassTokenSet): Promise<void> {
		const proc = Bun.spawn(
			[
				"/usr/bin/security",
				"add-generic-password",
				"-a",
				this.account,
				"-s",
				KEYCHAIN_SERVICE,
				"-U",
				"-w",
			],
			{ stdin: "pipe", stdout: "ignore", stderr: "ignore" },
		);
		proc.stdin.write(JSON.stringify(validateTokens(tokens)));
		proc.stdin.end();
		if ((await waitForCredentialProcess(proc)) !== 0) {
			throw new Error("AI Pass macOS Keychain update failed.");
		}
	}

	async clear(): Promise<void> {
		const proc = Bun.spawn(
			[
				"/usr/bin/security",
				"delete-generic-password",
				"-a",
				this.account,
				"-s",
				KEYCHAIN_SERVICE,
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		);
		const exitCode = await waitForCredentialProcess(proc);
		if (exitCode !== 0 && exitCode !== 44) {
			throw new Error("AI Pass macOS Keychain deletion failed.");
		}
	}
}

class LinuxSecretServiceAiPassTokenStore implements AiPassTokenStore {
	readonly kind = "linux-secret-service";

	constructor(private readonly account: string) {}

	async read(): Promise<AiPassTokenSet | null> {
		const proc = Bun.spawn(
			["secret-tool", "lookup", "vibe-tavern-instance", this.account],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
		);
		const outputPromise = readBoundedStdout(proc.stdout);
		const [exitCode, output] = await Promise.all([
			waitForCredentialProcess(proc),
			outputPromise,
		]);
		if (exitCode !== 0 || !output.trim()) return null;
		return decodeStoredTokens(output.trim());
	}

	async write(tokens: AiPassTokenSet): Promise<void> {
		const proc = Bun.spawn(
			[
				"secret-tool",
				"store",
				"--label=Vibe Tavern AI Pass OAuth",
				"vibe-tavern-instance",
				this.account,
			],
			{ stdin: "pipe", stdout: "ignore", stderr: "ignore" },
		);
		proc.stdin.write(JSON.stringify(validateTokens(tokens)));
		proc.stdin.end();
		if ((await waitForCredentialProcess(proc)) !== 0) {
			throw new Error("AI Pass Secret Service update failed.");
		}
	}

	async clear(): Promise<void> {
		const proc = Bun.spawn(
			["secret-tool", "clear", "vibe-tavern-instance", this.account],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		);
		const exitCode = await waitForCredentialProcess(proc);
		if (exitCode !== 0 && exitCode !== 1) {
			throw new Error("AI Pass Secret Service deletion failed.");
		}
	}
}

class WindowsDpapiAiPassTokenStore implements AiPassTokenStore {
	readonly kind = "windows-dpapi";
	private readonly filePath: string;

	constructor(dataDir: string) {
		this.filePath = resolve(dataDir, WINDOWS_SECRET_FILE);
	}

	async read(): Promise<AiPassTokenSet | null> {
		const script = [
			"Add-Type -AssemblyName System.Security",
			"$path = $args[0]",
			"if (-not (Test-Path -LiteralPath $path)) { exit 3 }",
			"$cipher = [IO.File]::ReadAllBytes($path)",
			"$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
			"[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
		].join("; ");
		const proc = Bun.spawn(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, this.filePath],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
		);
		const outputPromise = readBoundedStdout(proc.stdout);
		const [exitCode, output] = await Promise.all([
			waitForCredentialProcess(proc),
			outputPromise,
		]);
		if (exitCode === 3) return null;
		if (exitCode !== 0) throw new Error("AI Pass Windows Credential protection failed.");
		return decodeStoredTokens(output);
	}

	async write(tokens: AiPassTokenSet): Promise<void> {
		const script = [
			"Add-Type -AssemblyName System.Security",
			"$path = $args[0]",
			"$temp = \"$path.tmp\"",
			"$plain = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())",
			"$cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
			"[IO.File]::WriteAllBytes($temp, $cipher)",
			"Move-Item -LiteralPath $temp -Destination $path -Force",
		].join("; ");
		const proc = Bun.spawn(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, this.filePath],
			{ stdin: "pipe", stdout: "ignore", stderr: "ignore" },
		);
		proc.stdin.write(JSON.stringify(validateTokens(tokens)));
		proc.stdin.end();
		if ((await waitForCredentialProcess(proc)) !== 0) {
			throw new Error("AI Pass Windows Credential update failed.");
		}
	}

	async clear(): Promise<void> {
		try {
			await unlink(this.filePath);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw new Error("AI Pass Windows Credential deletion failed.");
			}
		}
	}
}

class UnavailableAiPassTokenStore implements AiPassTokenStore {
	readonly kind = "unavailable";

	async read(): Promise<AiPassTokenSet | null> {
		throw new Error("AI Pass credential storage is unavailable.");
	}

	async write(_tokens: AiPassTokenSet): Promise<void> {
		throw new Error("AI Pass credential storage is unavailable.");
	}

	async clear(): Promise<void> {}
}

export async function createNativeAiPassTokenStore(
	dataDir: string,
): Promise<AiPassTokenStore> {
	await mkdir(dataDir, { recursive: true });
	const account = await instanceAccount(dataDir);
	switch (process.platform) {
		case "darwin":
			return new MacOsKeychainAiPassTokenStore(account);
		case "win32":
			return new WindowsDpapiAiPassTokenStore(dataDir);
		case "linux":
			return new LinuxSecretServiceAiPassTokenStore(account);
		default:
			return new UnavailableAiPassTokenStore();
	}
}
