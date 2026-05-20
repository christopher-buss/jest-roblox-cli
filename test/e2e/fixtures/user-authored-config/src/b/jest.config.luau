-- User-authored jest config (no marker). The CLI must respect this file
-- and never overwrite it with a generated stub.
return {
	color = true,
	passWithNoTests = true,
	silent = false,
	testMatch = { "**/*.spec" },
	verbose = false,
	displayName = "b-user",
}
