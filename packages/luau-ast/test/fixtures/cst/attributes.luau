-- attributes: bare, bracketed, parametrized, on every function form
@native local function nativeLocal() end
@[native, checked] local function listed() end
@native @checked function twoBare() end
@native
function nextLine() end
local expression = @native function() end
@[ native ] function spaced() end
@[native] @[checked] function twoLists() end
@native @[checked] function bareThenList() end
@[checked] @native function listThenBare() end
@[deprecated({ use = "other" })] function parametrized() end
@[deprecated()] function emptyArguments() end
@[deprecated { use = "other", reason = "old" }] function tableArgument() end
@[deprecated { reason = "old" }] function tableWithoutParens() end
@[deprecated({ use = "other" }), native] function parametrizedInList() end
local t = {}
@native function t.method() end
@[checked] function t:selfMethod() end
local anonymous = { @native function() end, @[checked] function() end }

return nativeLocal, listed, twoBare, nextLine, expression, spaced, twoLists, bareThenList, listThenBare, parametrized, emptyArguments, tableArgument, tableWithoutParens, parametrizedInList, anonymous
