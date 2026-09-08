-- global declarations
declare declaredGlobal: number
declare declaredTable: { x: number, ["y"]: string, [number]: boolean }
declare declaredCallback: @checked (number) -> number
declare declaredSemicolon: string;

-- function declarations
declare function declaredFunction(x: number): string
declare function declaredNoReturn(x: number)
declare function declaredNoParams()
declare function declaredVarargs(first: number, ...: string): ...number
declare function declaredGeneric<T, U...>(first: T, ...: U...): (T, U...)
@checked declare function declaredChecked(x: number): number
declare function spaced ( a : number , b : string ) : ( number , string )
declare function declaredSemicolon(x: number): number;

-- extern types
declare extern type Vector with
	x: number
	read y: number
	write z: number
	["with space"]: string
	[number]: string
	function Dot(self, other: Vector): number
	function Variadic(self, ...: number): ()
	function NoArgs(self)
	@checked function Checked(self, x: number): number
end
declare extern type Empty with end
declare extern type Derived extends Vector with
	w: number
end
declare extern type Semicolon with end;
