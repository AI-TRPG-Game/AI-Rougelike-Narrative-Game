// Offline launcher preflight: share the server's provider selection and .env parser.
// Never print credentials or call a model API.
import { loadConfig } from './config.ts';

try {
  loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to load game/.env');
  process.exitCode = 1;
}
