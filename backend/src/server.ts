import { createBackend } from './app.js';
import { port } from '../../shared/config.js';
import { startServer, startupFailure } from '../../shared/server.js';

try {
  startServer(createBackend(), port(process.env.BACKEND_PORT, 3001, 'BACKEND_PORT'), process.env.BACKEND_HOST || '127.0.0.1', 'backend');
} catch (error) {
  startupFailure('backend', error, 'invalid_configuration');
}
