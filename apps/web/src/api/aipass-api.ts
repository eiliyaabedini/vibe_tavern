import { client, getGatewayBaseUrl } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

export interface AiPassStatusResponse {
	available: boolean;
	connected: boolean;
	profileId: string | null;
	storage: string;
	prerequisite: string | null;
}

export async function getAiPassStatus(): Promise<AiPassStatusResponse> {
	const response = await client.api.aipass.status.$get();
	return unwrapRpc<AiPassStatusResponse>(response);
}

export async function startAiPassAuthorization(): Promise<string> {
	const response = await client.api.aipass.start.$post({});
	const result = await unwrapRpc<{ launchPath: string }>(response);
	return new URL(result.launchPath, getGatewayBaseUrl()).href;
}

export async function disconnectAiPass(): Promise<{ revoked: boolean }> {
	const response = await client.api.aipass.disconnect.$post({});
	return unwrapRpc<{ revoked: boolean }>(response);
}
