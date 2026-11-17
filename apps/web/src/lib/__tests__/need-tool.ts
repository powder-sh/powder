// Tests that need a host tool (initdb, GNU timeout, the docker CLI) skip where the
// tool is missing, as on a developer Mac. On the Linux gate every tool is there, so a
// skip there would hide a broken test: .powder/test.sh sets
// POWDER_TEST_REQUIRE_FULL_SUITE=1 on Linux and a missing tool then FAILS the file
// instead (hermetic.ts keeps POWDER_TEST_* vars). See CONTRIBUTING.md, Tests.

/** True when the tool is present. When it is missing: logs why the tests skip and
 *  returns false, or throws under POWDER_TEST_REQUIRE_FULL_SUITE=1. */
export function needTool(file: string, present: boolean, why: string): boolean {
	if (present) return true
	if (process.env.POWDER_TEST_REQUIRE_FULL_SUITE === '1')
		throw new Error(
			`${file}: ${why}; POWDER_TEST_REQUIRE_FULL_SUITE=1 (the Linux gate) forbids skipping it`,
		)
	console.warn(`[skip] ${file}: ${why}`)
	return false
}
