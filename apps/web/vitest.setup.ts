import { afterAll, afterEach } from 'vitest'
import { installHermeticEnv, removeHermeticRoot } from './src/lib/__tests__/hermetic'
import { installNoLiveNetwork } from './src/lib/__tests__/no-live-network'

// No test inherits host state: HOME, git config, PG*, DOCKER_*, locale, TMPDIR
// and the real docker CLI are replaced for the whole file (see hermetic.ts).
const hermeticRoot = installHermeticEnv()
afterAll(() => removeHermeticRoot(hermeticRoot))

// No test reaches a live service: requests to a public host fail the test
// (see no-live-network.ts).
installNoLiveNetwork()

// Worker RPC (onTaskUpdate and friends) is answered by the main process, but
// the worker only reads the reply when its event loop reaches the poll phase.
// A file of synchronous tests (spawnSync of bash scripts, CPU-bound regex
// budgets) chains test after test through microtasks only, so the loop never
// turns until the file ends; by then the RPC timeout fires before the
// waiting reply is read, and the run exits 1 with "Timeout calling
// onTaskUpdate" although every test passed. One macrotask turn after each test
// lets the replies in. setImmediate is captured here so a test that installs
// fake timers cannot stall this hook.
const realSetImmediate = globalThis.setImmediate

afterEach(() => new Promise<void>((resolve) => realSetImmediate(() => resolve())))
