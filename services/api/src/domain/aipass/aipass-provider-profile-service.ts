import type {
	ModelFavoriteScope,
	ModelSettingsOverlay,
	StoredProviderProfileRecord,
} from "@vibe-tavern/domain";
import type {
	CachedProviderModelsRecord,
	ClientProviderProfileRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
} from "../../runtime/session/session-runtime-dto.js";
import { providerError } from "../../shared/errors.js";
import type {
	ProviderProfileService,
} from "../providers/provider-profile-service.js";
import type { AiPassCredentialManager } from "./aipass-credentials.js";

const AI_PASS_PRESET = "aipass";

function isAiPass(profile: { providerPreset: string }): boolean {
	return profile.providerPreset === AI_PASS_PRESET;
}

async function connected(
	credentials: AiPassCredentialManager,
): Promise<boolean> {
	try {
		return (await credentials.read()) !== null;
	} catch {
		return false;
	}
}

export function createAiPassProviderProfileService(
	base: ProviderProfileService,
	credentials: AiPassCredentialManager,
): ProviderProfileService {
	const clientProfile = async (
		profile: ClientProviderProfileRecord | null,
	): Promise<ClientProviderProfileRecord | null> => {
		if (!profile || !isAiPass(profile)) return profile;
		return {
			...profile,
			hasStoredApiKey: await connected(credentials),
		};
	};

	const hydrate = async (
		profile: StoredProviderProfileRecord | null,
	): Promise<StoredProviderProfileRecord | null> => {
		if (!profile || !isAiPass(profile)) return profile;
		return {
			...profile,
			apiKey: await credentials.getAccessToken(),
		};
	};

	return {
		listProviderProfiles: async () => {
			const profiles = await base.listProviderProfiles();
			const hasConnection = await connected(credentials);
			return profiles.map((profile) =>
				isAiPass(profile)
					? { ...profile, hasStoredApiKey: hasConnection }
					: profile,
			);
		},
		saveProviderProfile: async (
			profile: Partial<StoredProviderProfileRecord>,
		): Promise<ClientProviderProfileRecord> => {
			if (profile.providerPreset === AI_PASS_PRESET) {
				throw providerError(
					"Use Connect AI Pass to create this account connection.",
				);
			}
			return base.saveProviderProfile(profile);
		},
		deleteProviderProfile: async (id: string): Promise<void> => {
			const profile = await base.getProviderProfile(id);
			if (profile && isAiPass(profile)) {
				throw providerError(
					"Use Disconnect AI Pass to revoke and remove this connection.",
				);
			}
			return base.deleteProviderProfile(id);
		},
		reorderProviderProfiles: (
			updates: Array<{ id: string; sortOrder: number }>,
		): Promise<ClientProviderProfileRecord[]> =>
			base.reorderProviderProfiles(updates),
		activateProviderProfile: async (
			id: string,
		): Promise<ClientProviderProfileRecord> => {
			const profile = await base.getProviderProfile(id);
			if (profile && isAiPass(profile) && !(await connected(credentials))) {
				throw providerError("Connect AI Pass before activating this profile.");
			}
			const activated = await base.activateProviderProfile(id);
			return (await clientProfile(activated))!;
		},
		resolveActiveProviderProfile: async () =>
			hydrate(await base.resolveActiveProviderProfile()),
		updateProviderProfile: async (
			id: string,
			patch: Partial<
				Omit<
					StoredProviderProfileRecord,
					"id" | "isActive" | "createdAt" | "updatedAt"
				>
			>,
		): Promise<ClientProviderProfileRecord> => {
			const existing = await base.getProviderProfile(id);
			if (existing && isAiPass(existing)) {
				for (const field of [
					"apiKey",
					"endpoint",
					"providerPreset",
					"name",
				] as const) {
					if (Object.prototype.hasOwnProperty.call(patch, field)) {
						throw providerError(
							"Use Connect AI Pass to manage account connection fields.",
						);
					}
				}
			}
			const updated = await base.updateProviderProfile(id, patch);
			return (await clientProfile(updated))!;
		},
		getProviderProfile: async (id: string) =>
			hydrate(await base.getProviderProfile(id)),
		getProviderProfileForClient: async (id: string) =>
			clientProfile(await base.getProviderProfileForClient(id)),
		getCachedProviderModels: (
			providerProfileId: string,
		): Promise<CachedProviderModelsRecord | null> =>
			base.getCachedProviderModels(providerProfileId),
		setCachedProviderModels: (
			providerProfileId: string,
			models: Array<{
				id: string;
				label: string;
				contextLength?: number;
				capabilities?: {
					thinking?: boolean;
					tools?: boolean;
					vision?: boolean;
				};
			}>,
		): Promise<CachedProviderModelsRecord> =>
			base.setCachedProviderModels(providerProfileId, models),
		listFavoriteProviderModels: (
			providerProfileId: string,
			scope: ModelFavoriteScope,
		): Promise<FavoriteProviderModelRecord[]> =>
			base.listFavoriteProviderModels(providerProfileId, scope),
		addFavoriteProviderModel: (
			providerProfileId: string,
			model: {
				modelId: string;
				label?: string | null;
				contextLength?: number | null;
				scope: ModelFavoriteScope;
			},
		): Promise<FavoriteProviderModelRecord> =>
			base.addFavoriteProviderModel(providerProfileId, model),
		removeFavoriteProviderModel: (
			providerProfileId: string,
			body: { modelId: string; scope: ModelFavoriteScope },
		): Promise<void> =>
			base.removeFavoriteProviderModel(providerProfileId, body),
		listProviderModelSettings: (
			providerProfileId: string,
		): Promise<ProviderModelSettingsRecord[]> =>
			base.listProviderModelSettings(providerProfileId),
		getProviderModelSettings: (
			providerProfileId: string,
			modelId: string,
		): Promise<ProviderModelSettingsRecord | null> =>
			base.getProviderModelSettings(providerProfileId, modelId),
		upsertProviderModelSettings: (
			providerProfileId: string,
			modelId: string,
			settings: ModelSettingsOverlay,
		): Promise<ProviderModelSettingsRecord> =>
			base.upsertProviderModelSettings(
				providerProfileId,
				modelId,
				settings,
			),
		deleteProviderModelSettings: (
			providerProfileId: string,
			modelId: string,
		): Promise<void> =>
			base.deleteProviderModelSettings(providerProfileId, modelId),
	};
}
