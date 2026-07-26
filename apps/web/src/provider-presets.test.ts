import { describe, expect, it } from "vitest";
import {
	PROVIDER_PRESETS,
	getVisibleProviderPresets,
} from "./provider-presets.js";

describe("AI Pass provider presentation", () => {
	it("keeps the account connection out of the API-key preset picker", () => {
		expect(
			PROVIDER_PRESETS.find((preset) => preset.id === "aipass"),
		).toMatchObject({
			label: "AI Pass",
			accountConnection: true,
		});
		expect(
			getVisibleProviderPresets(false).some(
				(preset) => preset.id === "aipass",
			),
		).toBe(false);
	});
});
