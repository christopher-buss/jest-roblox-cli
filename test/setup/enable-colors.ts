import { enabledDefaultColors } from "tinyrainbow";

// Vitest 4.1.2+ calls disableDefaultColors() when running inside an AI agent
// (detected via std-env isAgent). This mutates the shared color singleton,
// which breaks tests that assert on ANSI-colored output. Re-enable here.
// Tracking: https://github.com/vitest-dev/vitest/issues/10046
enabledDefaultColors();
