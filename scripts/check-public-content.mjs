import { fileURLToPath } from 'node:url';
import { checkPublicContent } from './lib/public-content.mjs';
console.log(JSON.stringify(checkPublicContent(fileURLToPath(new URL('../',import.meta.url)))));
