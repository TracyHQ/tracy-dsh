/** Isolate an uncaught native-callback exception from the test runner. */
import { loadFlockBinding } from './flock-binding.js';

const binding = loadFlockBinding();
process.send({ type: 'ready' });
binding.unlinkat(2 ** 30, 'missing', false, () => { throw new Error('dirfd callback failure'); });
