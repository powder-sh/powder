/** is `timer` (e.g. `backup.timer`) one of the units in a
 *  `systemctl list-timers --all --no-legend` listing? Exact whitespace-separated field
 *  match, so `ssh.timer` never matches `myssh.timer`. */
export function timerListed(listing: string, timer: string): boolean {
	return listing.split('\n').some((l) => l.trim().split(/\s+/).includes(timer))
}
