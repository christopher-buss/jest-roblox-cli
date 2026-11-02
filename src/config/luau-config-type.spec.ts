import type { CstStat, CstTypeAlias, CstTypeTable } from "@isentinel/luau-ast/cst";

import { assert, describe, expect, it } from "vitest";

import { luauParser } from "../luau/parser.ts";
import { LUAU_CONFIG_TYPE_SOURCE } from "./luau-config-type.ts";
import { configSchema } from "./schema.ts";

type TableTypeAlias = CstTypeAlias & { value: CstTypeTable };

function isTableTypeAlias(statement: CstStat): statement is TableTypeAlias {
	return statement.type === "TypeAlias" && statement.value.type === "TypeTable";
}

function readLuauTypeKeys(): Map<string, Array<string>> {
	const parsed = luauParser.parseCst({
		fileName: "config.luau",
		source: LUAU_CONFIG_TYPE_SOURCE,
	});
	assert(parsed.ok, "expected the Luau config type to parse");

	return new Map(
		parsed.root.body.body
			.filter(isTableTypeAlias)
			.map((alias) => [
				alias.name.text,
				alias.value.items.flatMap(({ name }) => (name === undefined ? [] : [name.text])),
			]),
	);
}

const SCHEMA_ONLY_KEYS: ReadonlySet<string> = new Set(["config"]);

const testSchema = configSchema.get("test").exclude("undefined");
const inlineProjectSchema = testSchema
	.get("projects")
	.exclude("undefined")
	.get(0)
	.extract("object");

function keysOf(schema: { props: ReadonlyArray<{ key: string }> }): Array<string> {
	return schema.props.map(({ key }) => key).filter((key) => !SCHEMA_ONLY_KEYS.has(key));
}

const SCHEMA_KEYS = new Map<string, Array<string>>([
	["Config", keysOf(configSchema)],
	["CoverageThreshold", keysOf(testSchema.get("coverageThreshold").exclude("undefined"))],
	["DisplayName", keysOf(testSchema.get("displayName").extract("object"))],
	["GlobalTestConfig", keysOf(testSchema)],
	["InlineProjectConfig", keysOf(inlineProjectSchema)],
	["ProjectTestConfig", keysOf(inlineProjectSchema.get("test"))],
	["SnapshotFormatOptions", keysOf(testSchema.get("snapshotFormat").exclude("undefined"))],
	["TypecheckConfig", keysOf(testSchema.get("typecheck").exclude("undefined"))],
	["WorkspaceConfig", keysOf(configSchema.get("workspace").exclude("undefined"))],
]);

describe("luau config type", () => {
	it("should declare one table type for each schema object", () => {
		expect.assertions(1);

		expect([...readLuauTypeKeys().keys()].toSorted()).toStrictEqual(
			[...SCHEMA_KEYS.keys()].toSorted(),
		);
	});

	it.for([...SCHEMA_KEYS])(
		"should give %s the keys of its schema object",
		([typeName, schemaKeys]) => {
			expect.assertions(1);

			expect(readLuauTypeKeys().get(typeName)!.toSorted()).toStrictEqual(
				schemaKeys.toSorted(),
			);
		},
	);
});
