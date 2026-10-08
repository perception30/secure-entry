import { createGateway } from './app.js';
import { gatewayConfig } from '../../shared/config.js';
import { startServer } from '../../shared/server.js';

try {
  const config = gatewayConfig(process.env);
  startServer(createGateway(config), config.port, config.host, 'gateway');
} catch {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: 'invalid_configuration', service: 'gateway', message: 'Check OIDC and backend settings in .env' }));
  process.exitCode = 1;
}
