// Claim with a loop-level timeout that never orphans a committed claim.
//
// The claim is a DB transaction. When it takes longer than `ms` the worker loop
// stops WAITING (so a hung pool cannot wedge the loop), but the transaction can
// still commit later and flip a row to 'running'. If nobody executes that row
// the watchdog reaps it as failed and the push is never deployed. So on timeout
// the late result is chained onto the ORIGINAL promise and dispatched anyway.
export async function claimWithLateDispatch<T>(
	claim: Promise<T | null>,
	ms: number,
	label: string,
	dispatch: (row: T) => void,
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined
	let timedOut = false
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true
			reject(new Error(`${label} timed out after ${ms}ms`))
		}, ms)
	})
	try {
		return await Promise.race([claim, timeout])
	} finally {
		clearTimeout(timer)
		if (timedOut) {
			claim.then(
				(row) => {
					if (row) {
						console.error(`[worker] ${label} settled after its timeout - dispatching the late claim`)
						dispatch(row)
					}
				},
				() => {},
			)
		}
	}
}
