import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The build copies the public specification beside this module, independent of cwd.
export const openapi: object = JSON.parse(readFileSync(join(__dirname, 'openapi.json'), 'utf8')) as object;
