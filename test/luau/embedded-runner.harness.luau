--!nocheck
-- Lute-driven test for the embedded workspace runner's per-package Game
-- Output capture. The runner and the capture module it shares with runner.luau
-- are inlined into the placeholders below by embedded-runner.spec.ts; the fake
-- `game`, `require` and `warn` declared here are the upvalues both close over,
-- so every other sibling module is a stub defined in this file. Any failed
-- assertion calls error(), failing the wrapper spec.

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- Fake LogService.MessageOut: `emit` is what the stubbed materializer and Jest
-- call in place of print/warn.
local listeners = {}
local MessageOut = {}

function MessageOut:Connect(handler)
	local id = {}
	listeners[id] = handler
	return {
		Disconnect = function()
			listeners[id] = nil
		end,
	}
end

local OUTPUT = { Value = 0 }
local WARNING = { Value = 2 }

local function emit(message: string, messageType)
	for _, handler in listeners do
		handler(message, messageType)
	end
end

-- JSONEncode hands out a token and remembers the value behind it, so the
-- assertions below read the encoded Game Output back without a JSON codec.
local encoded = {}
local encodeCount = 0
local HttpService = {}

function HttpService:JSONEncode(value)
	encodeCount += 1
	local token = "json#" .. encodeCount
	encoded[token] = value
	return token
end

function HttpService:JSONDecode(token)
	return encoded[token]
end

local services = {
	HttpService = HttpService,
	LogService = { MessageOut = MessageOut },
	MemoryStoreService = {},
}

local game = {}

function game:GetService(name: string)
	local service = services[name]
	check(service ~= nil, "GetService: no such service " .. name)
	return service
end

local function warn() end

-- Per-package scripted behaviour: whether the materializer or Jest fails, or
-- whether the package prints nothing at all.
local materializeFails = {}
local jestFails = {}
local jestMissing = {}
local silent = {}

local function say(pkg: string, message: string, messageType)
	if not silent[pkg] then
		emit(message, messageType)
	end
end

local JestModule = {}
local Jest = {
	runCLI = function(_, config)
		return {
			expect = function()
				local pkg = config.pkg
				say(pkg, "jest:" .. pkg, OUTPUT)
				say(pkg, "warn:" .. pkg, WARNING)
				if jestFails[pkg] then
					error("jest exploded in " .. pkg, 0)
				end

				return { results = { success = true } }
			end,
		}
	end,
}

local stubs = {
	["../instance-resolver"] = {
		getJest = function(config)
			if jestMissing[config.pkg] then
				emit("missing:" .. config.pkg, WARNING)
				error("Failed to find Jest instance for " .. config.pkg, 0)
			end

			return JestModule
		end,
		findInstance = function(path)
			return path
		end,
	},
	["../intercept-writeable"] = {
		intercept = function()
			return function() end
		end,
	},
	["./materializer"] = {
		materialize = function(pkg)
			say(pkg, "materialize:" .. pkg, OUTPUT)
			if materializeFails[pkg] then
				error("no stage for " .. pkg, 0)
			end
		end,
		reset = function()
			emit("reset", WARNING)
		end,
	},
	["../phase-timing"] = {
		build = function()
			return nil
		end,
	},
	["../promise-error"] = {
		normalize = function(err)
			return tostring(err)
		end,
	},
	["./result-budget"] = {
		new = function()
			return {}
		end,
		shouldStop = function()
			return false
		end,
		add = function() end,
		measure = function()
			return 0
		end,
	},
	["../setup-timing"] = {
		patch = function()
			return nil
		end,
		unpatch = function() end,
		getSeconds = function()
			return 0
		end,
	},
	["../snapshot-patch"] = {
		patch = function()
			return nil
		end,
		unpatch = function() end,
	},
}

local function require(target)
	if target == JestModule then
		return Jest
	end

	local stub = stubs[target]
	check(stub ~= nil, "unstubbed require: " .. tostring(target))
	return stub
end

-- The real capture module, so the window under test is the one production
-- runs. Its own `require("./intercept-writeable")` only wants the type.
stubs["./intercept-writeable"] = stubs["../intercept-writeable"]
stubs["../game-output-capture"] = __CAPTURE_MODULE__

local EmbeddedRunner = __MODULE__

local function entryFor(pkg: string)
	-- `pkg` rides on the config so the Jest stub knows whose run it is.
	return { pkg = pkg, project = "unit", config = { pkg = pkg } }
end

local function messagesOf(result)
	local decoded = if result.gameOutput then HttpService:JSONDecode(result.gameOutput) else {}
	local messages = {}
	for _, record in decoded do
		table.insert(messages, record.message)
	end

	return messages
end

local function has(messages, wanted: string): boolean
	for _, message in messages do
		if message == wanted then
			return true
		end
	end

	return false
end

local function run(pkgs)
	local entries = {}
	for _, pkg in pkgs do
		table.insert(entries, entryFor(pkg))
	end

	return EmbeddedRunner.runEmbedded({}, { entries = entries })
end

-- T1: the capture opens before the package is materialized and spans its run,
-- and two packages that each print distinct messages get only their own —
-- including the reset between them, which belongs to neither capture.
local function testWindowAndNoBleedAcrossPackages()
	local results = run({ "a", "b" })
	local a = messagesOf(results[1])
	local b = messagesOf(results[2])

	check(has(a, "materialize:a") and has(a, "jest:a"), "T1: a has its own output")
	check(not has(a, "materialize:b") and not has(a, "jest:b"), "T1: a has none of b's output")
	check(has(b, "materialize:b") and has(b, "jest:b"), "T1: b has its own output")
	check(not has(b, "materialize:a") and not has(b, "jest:a"), "T1: b has none of a's output")
	check(not has(a, "reset") and not has(b, "reset"), "T1: reset output is attributed to neither")
end

-- T2: every record carries the message, its type and a timestamp.
local function testRecordShape()
	local results = run({ "a" })
	local decoded = HttpService:JSONDecode(results[1].gameOutput)

	local sawWarning = false
	for _, record in decoded do
		check(type(record.message) == "string", "T2: message is a string")
		check(type(record.messageType) == "number", "T2: messageType is a number")
		check(type(record.timestamp) == "number", "T2: timestamp is a number")
		if record.message == "warn:a" then
			sawWarning = record.messageType == 2
		end
	end

	check(sawWarning, "T2: warning records keep their message type")
end

-- T3: every failure path — a missing stage, a Jest rejection, a runner failure
-- before Jest is even found (no interception installed yet) — still returns
-- what was printed on the way down, as a per-package failure.
local FAILURE_CASES = {
	{ flags = materializeFails, pkg = "c", wanted = "materialize:c", label = "stage failure" },
	{ flags = jestFails, pkg = "d", wanted = "warn:d", label = "Jest rejection" },
	{ flags = jestMissing, pkg = "e", wanted = "missing:e", label = "runner failure" },
}

local function testFailuresKeepOutput()
	for _, case in FAILURE_CASES do
		case.flags[case.pkg] = true
		local results = run({ case.pkg })
		case.flags[case.pkg] = nil

		local decoded = HttpService:JSONDecode(results[1].jestOutput)
		check(decoded.success == false, "T3: " .. case.label .. " is a per-package failure")
		check(has(messagesOf(results[1]), case.wanted), "T3: " .. case.label .. " keeps its output")
	end
end

-- T4: a package that printed nothing has no Game Output at all, so the
-- envelope does not grow an empty field per silent package.
local function testSilentPackageHasNoOutput()
	silent.f = true
	local results = run({ "f" })
	silent.f = nil

	check(results[1].gameOutput == nil, "T4: silent package has no gameOutput")
end

testWindowAndNoBleedAcrossPackages()
testRecordShape()
testFailuresKeepOutput()
testSilentPackageHasNoOutput()

print("ALL OK")
