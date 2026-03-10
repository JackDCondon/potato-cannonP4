export { main, startServer, stopServer, getStatus } from './server/server.js';

// Export types
export * from './types/index.js';

// Export stores
export * from './stores/index.js';

// Export services
export * from './services/index.js';

// Auto-start if run directly
import { pathToFileURL } from 'url';
import { main } from './server/server.js';

const entryPath = process.argv[1];
const entryUrl = entryPath ? pathToFileURL(entryPath).href : null;

if (entryUrl && import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
