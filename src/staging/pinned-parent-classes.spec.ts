import { describe, expect, it } from "vitest";

import { PINNED_PARENT_CLASSES } from "./pinned-parent-classes.ts";

describe("pinned parent classes", () => {
	it("should contain every class whose parent is fixed by Roblox", () => {
		expect.assertions(1);

		expect([...PINNED_PARENT_CLASSES]).toStrictEqual([
			"Chat",
			"CollectionService",
			"DataModel",
			"HttpService",
			"Lighting",
			"LocalizationService",
			"MarketplaceService",
			"MaterialService",
			"MessagingService",
			"Players",
			"ReplicatedFirst",
			"ReplicatedStorage",
			"RunService",
			"ServerScriptService",
			"ServerStorage",
			"SoundService",
			"StarterCharacterScripts",
			"StarterGui",
			"StarterPack",
			"StarterPlayer",
			"StarterPlayerScripts",
			"Teams",
			"Terrain",
			"TestService",
			"TextChatService",
			"TweenService",
			"UserInputService",
			"Workspace",
		]);
	});
});
