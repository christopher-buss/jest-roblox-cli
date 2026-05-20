-- Stand-in for a vendored Luau dependency. The HAL-215 regression test
-- asserts this file's shadow does NOT appear under
-- .jest-roblox/workspace/@e2e-vendored-mount/coverage/vendored-packages/
-- when the package config restricts coverage to src/ via luauRoots or
-- coveragePathIgnorePatterns. Pre-fix, workspace mode walked every rojo
-- $path mount and instrumented this file alongside the user's source.
return {}
