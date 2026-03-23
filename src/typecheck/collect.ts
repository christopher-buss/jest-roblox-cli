import type {
	CallExpression,
	Expression,
	IdentifierReference,
	StaticMemberExpression,
	StringLiteral,
	TemplateLiteral,
} from "@oxc-project/types";

import { parseSync, Visitor } from "oxc-parser";

import type { TestDefinition } from "./types.ts";

const TEST_FUNCTIONS = new Set(["it", "test"]);
const SUITE_FUNCTIONS = new Set(["describe", "suite"]);
const ALL_FUNCTIONS = new Set([...SUITE_FUNCTIONS, ...TEST_FUNCTIONS]);

interface RawDefinition {
	name: string;
	end: number;
	start: number;
	type: "suite" | "test";
}

export function collectTestDefinitions(source: string): Array<TestDefinition> {
	const result = parseSync("test.ts", source);
	const raw: Array<RawDefinition> = [];

	const visitor = new Visitor({
		CallExpression(node) {
			const definition = extractDefinition(node, source);
			if (definition) {
				raw.push(definition);
			}
		},
	});

	visitor.visit(result.program);
	raw.sort((a, b) => a.start - b.start);

	return buildAncestorChain(raw);
}

function buildAncestorChain(sorted: Array<RawDefinition>): Array<TestDefinition> {
	const result: Array<TestDefinition> = [];
	const suiteStack: Array<{ end: number; name: string }> = [];

	for (const definition of sorted) {
		while (
			suiteStack.length > 0 &&
			suiteStack.at(-1)!.end <= definition.start // eslint-disable-line ts/no-non-null-assertion -- stack length > 0
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

function isStringLiteral(node: Expression): node is StringLiteral {
	return node.type === "Literal" && typeof node.value === "string";
}

function isTemplateLiteral(node: Expression): node is TemplateLiteral {
	return node.type === "TemplateLiteral";
}

// cspell:ignore quasis
function extractStringArgument(node: Expression, source: string): string {
	if (isStringLiteral(node)) {
		return node.value;
	}

	if (isTemplateLiteral(node)) {
		if (node.quasis.length === 1 && node.quasis[0] !== undefined) {
			return node.quasis[0].value.raw;
		}

		return source.slice(node.start + 1, node.end - 1);
	}

	return source.slice(node.start, node.end);
}

function isIdentifier(node: Expression): node is IdentifierReference {
	return node.type === "Identifier";
}

function isStaticMemberExpression(node: Expression): node is StaticMemberExpression {
	return node.type === "MemberExpression" && "computed" in node && !node.computed;
}

function getCalleeName(callee: Expression): string | undefined {
	if (isIdentifier(callee)) {
		return callee.name;
	}

	if (
		isStaticMemberExpression(callee) &&
		isIdentifier(callee.object) &&
		ALL_FUNCTIONS.has(callee.object.name)
	) {
		return callee.object.name;
	}

	return undefined;
}

function extractDefinition(node: CallExpression, source: string): RawDefinition | undefined {
	const name = getCalleeName(node.callee);
	if (name === undefined || !ALL_FUNCTIONS.has(name)) {
		return undefined;
	}

	const firstArgument = node.arguments[0];
	if (firstArgument === undefined || firstArgument.type === "SpreadElement") {
		return undefined;
	}

	return {
		name: extractStringArgument(firstArgument, source),
		end: node.end,
		start: node.start,
		type: TEST_FUNCTIONS.has(name) ? "test" : "suite",
	};
}
