import { randomBytes } from 'node:crypto'

/** a temp name next to `path` nobody can predict (16 random hex chars). The
 *  SFTP write that creates it is exclusive (O_CREAT|O_EXCL, writeFileViaSftp
 *  `exclusive`), so a file or link planted there makes the write fail instead of
 *  being written through. Pure, so modules that mock the SSH layer keep it. */
export function randomTempPath(path: string): string {
	return `${path}.tmp.${randomBytes(8).toString('hex')}`
}

/** POSIX ERE for the suffix randomTempPath appends (`.tmp.<16 hex>`), for
 *  matching such a path in a process list. */
export const RANDOM_TEMP_SUFFIX_ERE = '\\.tmp\\.[0-9a-f]{16}'

/** The temp deploy key of the repo clone action: `randomTempPath(CLONE_KEY_TMP_PREFIX)`.
 *  The clone script removes such a file when it exits, and only a path of exactly
 *  this shape (cloneKeyTmpPathOk). */
export const CLONE_KEY_TMP_PREFIX = '/tmp/powder-clone-key'

/** True for exactly `<CLONE_KEY_TMP_PREFIX>.tmp.<16 hex>`. Pure. */
export function cloneKeyTmpPathOk(path: string): boolean {
	return new RegExp(`^${CLONE_KEY_TMP_PREFIX.replace(/[.]/g, '\\.')}${RANDOM_TEMP_SUFFIX_ERE}$`).test(path)
}
