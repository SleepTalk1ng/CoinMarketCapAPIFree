const { randomBytes } = require('node:crypto');
const fs = require('node:fs');

const content = fs.readFileSync('.env', 'utf8');
const placeholder = /^SERVICE_API_KEY=replace-with-a-random-service-key(?=\r?$)/m;
if (/^\s*SERVICE_API_KEY\s*=/m.test(content) && !placeholder.test(content)) {
  throw new Error('SERVICE_API_KEY already exists; its value was preserved.');
}

const assignment = `SERVICE_API_KEY=${randomBytes(32).toString('hex')}`;
if (placeholder.test(content)) {
  fs.writeFileSync('.env', content.replace(placeholder, assignment));
} else {
  fs.appendFileSync('.env', `${content.endsWith('\n') ? '' : '\n'}${assignment}\n`);
}
console.info('SERVICE_API_KEY prepared without printing its value.');
