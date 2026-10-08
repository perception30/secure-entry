import { createBackend } from './app.js';
import { port } from '../../shared/config.js';
import { startServer } from '../../shared/server.js';

try {
  startServer(createBackend(), port(process.env.BACKEND_PORT, 3001), process.env.BACKEND_HOST || '127.0.0.1', 'backend');
} catch {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: 'invalid_configuration', service: 'backend' }));
  process.exitCode = 1;
}
