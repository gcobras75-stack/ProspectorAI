// Permite que node --test cargue módulos de web-lib/ que importan sin extensión ('./userScope'), como hace Metro/tsc.
// Uso: node --import ./scripts/ts-resolve.mjs --test scripts/test-user-scope.mjs
import { register } from 'node:module';
register('./ts-resolve-hooks.mjs', import.meta.url);
