// Started detached by `cc-account header` when a lane token nears its end, so the session asking for
// it is answered at once and the renewal finishes on its own. Arguments: <account> [server].
import { renewLane } from './lanes.js';
import { resolvePaths } from './paths.js';

const [name, server] = process.argv.slice(2);
if (name) renewLane(resolvePaths(), name, server, { wait: false });
