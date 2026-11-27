// Started detached by `cc-account header` and by the minute poll when a lane token nears its end, so
// the renewal finishes on its own whoever started it. Arguments: <account> [server].
import { renewLane } from './lanes.js';
import { resolvePaths } from './paths.js';

const [name, server] = process.argv.slice(2);
if (name) renewLane(resolvePaths(), name, server);
