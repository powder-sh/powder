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
