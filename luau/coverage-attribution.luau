--!strict
-- `s` is the wire key; it must match `RawFileCoverage` on the TypeScript side.
type FileHitCounts = { s: { number } }
type HitTableByFile = { [string]: FileHitCounts }

type FileStatementDelta = { s: { number } }
type CoverageDeltaByFile = { [string]: FileStatementDelta }

local module = {}

function module.snapshot(coverage: HitTableByFile): HitTableByFile
	local baseline: HitTableByFile = {}
	for fileKey, fileHitCounts in coverage do
		local statementCounts: { number } = {}
		for statementId, hitCount in fileHitCounts.s do
			statementCounts[statementId] = hitCount
		end

		baseline[fileKey] = { s = statementCounts }
	end

	return baseline
end

function module.diff(before: HitTableByFile, after: HitTableByFile): CoverageDeltaByFile
	local delta: CoverageDeltaByFile = {}
	for fileKey, afterCounts in after do
		local beforeCounts = before[fileKey]
		local coveredStatementIds: { number } = {}

		for statementId, afterHitCount in afterCounts.s do
			local beforeHitCount = if beforeCounts then beforeCounts.s[statementId] or 0 else 0
			if afterHitCount > beforeHitCount then
				table.insert(coveredStatementIds, statementId)
			end
		end

		if #coveredStatementIds > 0 then
			delta[fileKey] = { s = coveredStatementIds }
		end
	end

	return delta
end

return module
