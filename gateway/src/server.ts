import { createGateway } from './app.js';
import { gatewayConfig } from '../../shared/config.js';
import { startServer, startupFailure } from '../../shared/server.js';

try {
  const config = gatewayConfig(process.env);
  startServer(createGateway(config), config.port, config.host, 'gateway');
} catch (error) {
  startupFailure('gateway', error, 'invalid_configuration');
}
