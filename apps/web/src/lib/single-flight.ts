// One read at a time, without losing a request. run(true) while a read is in flight
// queues one follow-up read after it (shared by every such request, so a burst of
// requests costs one extra read); run(false) joins the read in flight instead (a
// poll that would only repeat it). Used by the app page's project context.

export function singleFlight(read: () => Promise<void>): (queue: boolean) => Promise<void> {
	let current: Promise<void> | null = null
	let followUp: Promise<void> | null = null
	const run = (queue: boolean): Promise<void> => {
		if (current) {
			if (!queue) return current
			if (!followUp) {
				followUp = current.then(() => {
					followUp = null
					return run(false)
				})
			}
			return followUp
		}
		const p: Promise<void> = Promise.resolve()
			.then(read)
			.catch(() => {})
			.finally(() => {
				if (current === p) current = null
			})
		current = p
		return p
	}
	return run
}
