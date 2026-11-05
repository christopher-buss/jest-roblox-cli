import type { RawTestDefinition, TestDefinition } from "./typecheck-types.ts";

/**
 * Attach to each definition the names of the suites that enclose it.
 * @param sorted - Definitions in source order.
 * @returns The definitions with their ancestor names.
 */
export function buildAncestorChain(sorted: Array<RawTestDefinition>): Array<TestDefinition> {
	const result: Array<TestDefinition> = [];
	const suiteStack: Array<{
		/** Source offset where the suite ends. */
		end: number;
		/** The suite's title. */
		name: string;
	}> = [];

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
