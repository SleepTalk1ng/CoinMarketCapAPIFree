const { copyFileSync, mkdirSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const output = process.argv[2];
if (output !== 'dist' && output !== '.test-build/src') {
  throw new Error('Expected dist or .test-build/src as the build output.');
}
const root = resolve(__dirname, '..');
const source = join(root, 'migrations');
const destination = join(root, output, 'db', 'migrations');
mkdirSync(destination, { recursive: true });
for (const filename of readdirSync(source).filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))) {
  copyFileSync(join(source, filename), join(destination, filename));
}
const httpOutput = join(root, output, 'http');
mkdirSync(httpOutput, { recursive: true });
copyFileSync(join(root, 'docs', 'openapi.json'), join(httpOutput, 'openapi.json'));
