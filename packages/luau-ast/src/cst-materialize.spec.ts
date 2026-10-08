import { describe, expect, it } from "vitest";

import { materializeCst } from "./cst-materialize.ts";

describe(materializeCst, () => {
	it("should preserve whitespace in an empty block's end token", () => {
		expect.assertions(1);

		const result = materializeCst({
			json: '{"type":"Root","location":[0,0,0,1],"body":{"type":"Block","location":[0,0,0,1],"body":[]}}',
			source: " ",
		});

		expect(result).toMatchObject({
			ok: true,
			root: { eof: { leading: [{ kind: "whitespace", text: " " }], text: "" } },
		});
	});
});
