import type { ProviderRuntimeApi } from "../contract/runtime-api.js";
import type { ClientProviderProfileRecord } from "../../runtime/session/session-runtime-dto.js";
import { notFound } from "../../shared/errors.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ModelFavoriteScope, ModelSettingsOverlay } from "@vibe-tavern/domain";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import {
	probeProviderConnection,
	testProviderChat,
	listProviderModels,
	normalizeOpenAiCompatibleBaseUrl,
} from "../../domain/providers/provider-gateway.js";
import { providerError } from "../../shared/errors.js";
import { isAiPassEndpoint } from "../../domain/aipass/aipass-transport.js";

const AI_PASS_PRESET = "aipass";

function rejectAiPassGenericPath(
	providerType: unknown,
	endpoint?: unknown,
): void {
	if (providerType === AI_PASS_PRESET || isAiPassEndpoint(endpoint)) {
		throw providerError(
			"Use Connect AI Pass to manage this account connection.",
		);
	}
}

export class ProviderAdapter implements ProviderRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		private readonly providerProfileService: ProviderProfileService,
	) {}

	listProviderProfiles = () => this.providerProfileService.listProviderProfiles();
	reorderProviderProfiles = (updates: Array<{ id: string; sortOrder: number }>) => this.providerProfileService.reorderProviderProfiles(updates);

	fetchProviderProfile = async (providerProfileId: string): Promise<ClientProviderProfileRecord> => {
		const profile = await this.providerProfileService.getProviderProfileForClient(providerProfileId);
		if (!profile) {
			throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
		}
		return profile;
	};

	activateProviderProfile = (providerProfileId: string) =>
		this.providerProfileService.activateProviderProfile(providerProfileId);

	updateProviderProfile = async (providerProfileId: string, body: Record<string, unknown>) => {
		rejectAiPassGenericPath(
			body.providerPreset,
			body.endpoint,
		);
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		if (profile.providerPreset === AI_PASS_PRESET) {
			for (const field of ["apiKey", "endpoint", "providerPreset", "name"]) {
				if (Object.prototype.hasOwnProperty.call(body, field)) {
					throw providerError(
						"Use Connect AI Pass to manage account connection fields.",
					);
				}
			}
		}
		return this.providerProfileService.updateProviderProfile(
			providerProfileId,
			body,
		);
	};

	saveProviderDraft = async (body: Record<string, unknown>) => {
		rejectAiPassGenericPath(body.providerPreset, body.endpoint);
		return this.providerProfileService.saveProviderProfile(body);
	};

	testProviderDraft = async (body: { endpoint?: string; apiKey?: string; providerType?: string } | null) => {
		rejectAiPassGenericPath(body?.providerType, body?.endpoint);
		const endpoint = (body?.endpoint ?? "").trim();
		const apiKey = (body?.apiKey ?? "").trim();
		return probeProviderConnection({ baseUrl: endpoint, apiKey, providerType: body?.providerType });
	};

	testProviderProfile = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		return probeProviderConnection({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
		});
	};

	deleteProviderProfile = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		if (profile.providerPreset === AI_PASS_PRESET) {
			throw providerError(
				"Use Disconnect AI Pass to revoke and remove this connection.",
			);
		}
		return this.providerProfileService.deleteProviderProfile(providerProfileId);
	};

	fetchProviderModels = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		const models = await listProviderModels({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
			requiresAuthForModels: profile.providerPreset === "anthropic" || profile.providerPreset === "google" || profile.providerPreset === "unsloth",
		});

		// Persist to DB cache so send path has capability data
		const normalized = models.map((m) => ({
			id: m.id,
			label: m.label ?? m.id,
			...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
			...(m.capabilities ? { capabilities: { thinking: m.capabilities.reasoning, tools: m.capabilities.tools, vision: m.capabilities.vision } } : {}),
		}));
		await this.providerProfileService.setCachedProviderModels(providerProfileId, normalized);

		return { models };
	};

	listFavoriteProviderModels = (providerProfileId: string, scope: ModelFavoriteScope) =>
		this.providerProfileService.listFavoriteProviderModels(providerProfileId, scope);

	addFavoriteProviderModel = (
		providerProfileId: string,
		body: { modelId: string; label?: string | null; contextLength?: number | null; scope: ModelFavoriteScope },
	) => this.providerProfileService.addFavoriteProviderModel(providerProfileId, body);

	removeFavoriteProviderModel = (providerProfileId: string, body: { modelId: string; scope: ModelFavoriteScope }) =>
		this.providerProfileService.removeFavoriteProviderModel(providerProfileId, body);

	listProviderModelSettings = (providerProfileId: string) =>
		this.providerProfileService.listProviderModelSettings(providerProfileId);

	getProviderModelSettings = (providerProfileId: string, modelId: string) =>
		this.providerProfileService.getProviderModelSettings(providerProfileId, modelId);

	upsertProviderModelSettings = (
		providerProfileId: string,
		modelId: string,
		settings: ModelSettingsOverlay,
	) => this.providerProfileService.upsertProviderModelSettings(providerProfileId, modelId, settings);

	deleteProviderModelSettings = (providerProfileId: string, modelId: string) =>
		this.providerProfileService.deleteProviderModelSettings(providerProfileId, modelId);

	fetchModelsByEndpoint = async (baseUrl: string, apiKey?: string, providerType?: string) => {
		rejectAiPassGenericPath(providerType, baseUrl);
		const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
		const requiresAuth = providerType === "anthropic" || providerType === "google" || providerType === "unsloth";
		return listProviderModels({
			baseUrl: normalized,
			apiKey: apiKey ?? "",
			providerType,
			requiresAuthForModels: requiresAuth,
		});
	};

	testProviderChatByEndpoint = async (opts: {
		baseUrl: string;
		apiKey: string;
		model: string;
		providerType?: string;
	}) => {
		rejectAiPassGenericPath(opts.providerType, opts.baseUrl);
		return testProviderChat(opts);
	};

	testProviderChatByProfile = async (providerProfileId: string, model: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		return testProviderChat({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			model,
			providerType: profile.providerPreset,
		});
	};

	private async getRequiredProviderProfile(providerProfileId: string) {
		const profile = await this.providerProfileService.getProviderProfile(providerProfileId);
		if (!profile) {
			throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
		}
		return profile;
	}
}
