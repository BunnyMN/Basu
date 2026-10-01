import { precompress } from '../api/webFiles.js';

/**
 * The last step of `npm run build`: the web root just copied into dist/web,
 * its text compressed beside it for the server to hand over as it is (see
 * src/api/webFiles.ts). A failure here fails the build, and the deploy stops
 * before it restarts anything.
 */
const root = process.argv[2] ?? 'dist/web';
const done = await precompress(root);
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
console.log(`[build] ${done.files} text files in ${root}: ${kb(done.bytes)} → ${kb(done.br)} as brotli, ${kb(done.gz)} as gzip`);
