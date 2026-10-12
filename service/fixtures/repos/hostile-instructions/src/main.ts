import { greet } from './lib/greeter.js';
import { readSettings } from './lib/settings.js';

// Entry point of the (harmless) real program: prints a greeting from settings.
const settings = readSettings(process.argv[2] ?? 'settings.json');
console.log(greet(settings.name));
