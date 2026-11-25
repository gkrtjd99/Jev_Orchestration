import { loadSettings } from './config/settings.mjs';
import { dispatch } from './http/dispatch.mjs';
import { createStore, loadSeed } from './store/store.mjs';

// Usage: node src/main.mjs GET /parcels/P-1001
const [method = 'GET', path = '/health'] = process.argv.slice(2);
const settings = loadSettings();
const store = createStore(loadSeed(settings.storePath));
const response = await dispatch({ method: method.toUpperCase(), path, store });
console.log(JSON.stringify(response, null, 2));
