import { fromAny } from "@total-typescript/shoehorn";

import type { Backend } from "#src/backends/dispatch-request.ts";
import type { BackendResult, DispatchBase } from "#src/backends/interface.ts";

export function fakeBackendOfKind(
	kind: Backend["kind"],
	fields: Pick<Backend, "closeAsync"> & {
		runTestsAsync: (request: DispatchBase) => Promise<BackendResult>;
	},
): Backend {
	return fromAny<Backend, unknown>({ ...fields, kind });
}
