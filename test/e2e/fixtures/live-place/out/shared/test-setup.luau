-- Compiled with sloptor v3.0.0-beta.4
-- Live OCALE runs reuse a single Roblox VM across multiple project mounts.
-- roblox-ts caches required modules in `_G` keyed by ModuleScript instances;
-- without clearing, a project's modules can collide with a sibling project's.
-- Reset before every project's tests so each starts from a clean require graph.
for key in pairs(_G) do
	if typeof(key) == "Instance" and key:IsA("ModuleScript") then
		_G[key] = nil
	end
end
return nil
