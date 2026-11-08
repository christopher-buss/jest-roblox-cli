import type { CstCall, CstExpr } from "./cst.ts";
import { decodeLuauString } from "./string-literal.ts";

/** One step from an Instance to its parent or to a named child. */
export type InstanceTraversal = { kind: "child"; name: string } | { kind: "parent" };

/**
 * A constant Instance expression: where it starts, and each step from there.
 */
export interface InstancePath {
	/** `script`, or `game` for a path that starts at `game:GetService(...)`. */
	root: "game" | "script";
	/**
	 * Steps from the root; a `game` path starts with its service as a child.
	 */
	segments: Array<InstanceTraversal>;
}

/**
 * What one `require` or `TS.import` call loads, read from its syntax alone.
 *
 * - `string`: `require("./x")`, with the decoded require-by-string path.
 * - `instance`: `require(script.Parent.X)` or a `game:GetService(...)` path.
 * - `ts-import`: `TS.import(script, <base>, "a", "b")`, a base Instance path
 *   and the child names after it.
 * - `ts-package`: `TS.import(script, TS.getModule(script, "@scope",
 * "name").x)`,
 *   the package's `TS.getModule` strings, then each name after them.
 * - `dynamic`: a call whose target the syntax does not fix.
 */
export type RequireCall =
	| { base: InstancePath; kind: "ts-import"; segments: Array<string> }
	| { kind: "dynamic" }
	| { kind: "instance"; path: InstancePath }
	| { kind: "string"; path: string }
	| { kind: "ts-package"; segments: Array<string> };

interface InstanceStep {
	receiver: CstExpr;
	traversal: InstanceTraversal;
}

const DYNAMIC: RequireCall = { kind: "dynamic" };
const CHILD_METHODS: ReadonlySet<string> = new Set(["FindFirstChild", "WaitForChild"]);

/**
 * Read what a `require(...)` or `TS.import(...)` call loads. `require` and `TS`
 * match a global or a local of that name.
 *
 * @param call - Any call expression.
 * @returns What the call loads, or `undefined` when it is not a require.
 */
export function readRequireCall(call: CstCall): RequireCall | undefined {
	if (identifierName(call.callee) === "require") {
		return readRequire(call);
	}

	return isTsMethodCall(call, "import") ? readTsImport(call) : undefined;
}

function identifierName(expression: CstExpr): string | undefined {
	return expression.type === "Global" || expression.type === "LocalRef"
		? expression.name.text
		: undefined;
}

function isTsMethodCall(expression: CstExpr, name: string): expression is CstCall {
	if (expression.type !== "Call") {
		return false;
	}

	const { callee } = expression;
	return (
		callee.type === "IndexName" &&
		callee.operator.text === "." &&
		callee.index.text === name &&
		identifierName(callee.expr) === "TS"
	);
}

function stringValue(expression: CstExpr): string | undefined {
	return expression.type === "String" ? decodeLuauString(expression.token.text) : undefined;
}

function onlyStringArgument(call: CstCall): string | undefined {
	const [argument, ...rest] = call.arguments;
	return argument === undefined || rest.length > 0 ? undefined : stringValue(argument.node);
}

function readService(expression: CstExpr): string | undefined {
	if (expression.type !== "Call" || expression.callee.type !== "IndexName") {
		return undefined;
	}

	const { callee } = expression;
	return callee.operator.text === ":" &&
		callee.index.text === "GetService" &&
		identifierName(callee.expr) === "game"
		? onlyStringArgument(expression)
		: undefined;
}

function readStep(expression: CstExpr): InstanceStep | undefined {
	if (expression.type === "IndexName") {
		const name = expression.index.text;
		return {
			receiver: expression.expr,
			traversal: name === "Parent" ? { kind: "parent" } : { name, kind: "child" },
		};
	}

	if (expression.type === "IndexExpr") {
		const name = stringValue(expression.index);
		return name === undefined
			? undefined
			: { receiver: expression.expr, traversal: { name, kind: "child" } };
	}

	if (expression.type !== "Call" || expression.callee.type !== "IndexName") {
		return undefined;
	}

	const { callee } = expression;
	const name = onlyStringArgument(expression);
	return name !== undefined &&
		callee.operator.text === ":" &&
		CHILD_METHODS.has(callee.index.text)
		? { receiver: callee.expr, traversal: { name, kind: "child" } }
		: undefined;
}

function readInstancePath(expression: CstExpr): InstancePath | undefined {
	const steps: Array<InstanceTraversal> = [];
	let current = expression;
	for (;;) {
		if (identifierName(current) === "script") {
			return { root: "script", segments: steps.toReversed() };
		}

		const service = readService(current);
		if (service !== undefined) {
			return {
				root: "game",
				segments: [{ name: service, kind: "child" }, ...steps.toReversed()],
			};
		}

		const step = readStep(current);
		if (step === undefined) {
			return undefined;
		}

		steps.push(step.traversal);
		current = step.receiver;
	}
}

function readRequire(call: CstCall): RequireCall {
	const [argument, ...rest] = call.arguments;
	if (argument === undefined || rest.length > 0) {
		return DYNAMIC;
	}

	const path = stringValue(argument.node);
	if (path !== undefined) {
		return { kind: "string", path };
	}

	const instancePath = readInstancePath(argument.node);
	return instancePath === undefined ? DYNAMIC : { kind: "instance", path: instancePath };
}

function stringValues(expressions: ReadonlyArray<CstExpr>): Array<string> | undefined {
	const values = expressions.map(stringValue);
	return values.every((value) => value !== undefined) ? values : undefined;
}

function readPackageBase(expression: CstExpr): Array<string> | undefined {
	const members: Array<string> = [];
	let current = expression;
	while (current.type === "IndexName") {
		members.unshift(current.index.text);
		current = current.expr;
	}

	if (!isTsMethodCall(current, "getModule")) {
		return undefined;
	}

	const names = stringValues(current.arguments.slice(1).map(({ node }) => node));
	return names === undefined ? undefined : [...names, ...members];
}

function readTsImport(call: CstCall): RequireCall {
	const [, base, ...rest] = call.arguments;
	const segments = stringValues(rest.map(({ node }) => node));
	if (base === undefined || segments === undefined) {
		return DYNAMIC;
	}

	const packageSegments = readPackageBase(base.node);
	if (packageSegments !== undefined) {
		return { kind: "ts-package", segments: [...packageSegments, ...segments] };
	}

	const basePath = readInstancePath(base.node);
	return basePath === undefined ? DYNAMIC : { base: basePath, kind: "ts-import", segments };
}
