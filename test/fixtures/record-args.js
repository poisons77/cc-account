// Stands in for a browser: records the arguments it was opened with, to the file named first.
import fs from 'node:fs';

const [out, ...args] = process.argv.slice(2);
fs.writeFileSync(`${out}.tmp`, JSON.stringify(args));
fs.renameSync(`${out}.tmp`, out);
