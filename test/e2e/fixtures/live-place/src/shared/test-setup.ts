// Live OCALE runs reuse a single Roblox VM across multiple project mounts.
// roblox-ts caches required modules in `_G` keyed by ModuleScript instances;
// without clearing, a project's modules can collide with a sibling project's.
// Reset before every project's tests so each starts from a clean require graph.
for (const [key] of pairs(_G)) {
	if (typeIs(key, "Instance") && key.IsA("ModuleScript")) {
		delete (_G as Record<string, unknown>)[key as unknown as string];
	}
}
