import type { RawTestDefinition, TestDefinition } from "./types.ts";

export function buildAncestorChain(sorted: Array<RawTestDefinition>): Array<TestDefinition> {
	const result: Array<TestDefinition> = [];
	const suiteStack: Array<{ end: number; name: string }> = [];

	for (const definition of sorted) {
		while (
			suiteStack.length > 0 &&
			// Stryker disable next-line EqualityOperator: calls never abut.
			suiteStack.at(-1)!.end <= definition.start // oxlint-disable-line typescript/no-non-null-assertion -- stack length > 0
		) {
			suiteStack.pop();
		}

		result.push({
			...definition,
			ancestorNames: suiteStack.map((suite) => suite.name),
		});

		if (definition.type === "suite") {
			suiteStack.push({ name: definition.name, end: definition.end });
		}
	}

	return result;
}
