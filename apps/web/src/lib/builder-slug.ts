import { createHash } from 'node:crypto'

/** the builder workdir slug `/opt/builds/<slug>`. `<server>-<basename>-<app>`
 *  could collide (`a-b` + `c` vs `a` + `b-c`, or two work dirs with one basename), and
 *  two colliding builder phases rm -rf each other's clone. The hash covers the full
 *  server id, work dir and app, with a separator none of them can hold unescaped. */
export function builderDirSlug(serverId: string, workingDir: string, app: string): string {
	const h = createHash('sha256').update(JSON.stringify([serverId, workingDir, app])).digest('hex').slice(0, 16)
	return `${h}-${app}`
}
