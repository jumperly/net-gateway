import { loadConfig } from './config';
import { BrokerRegistry } from './mqtt/brokers';
import { type DebugPort, startDebugPort } from './mqtt/debug-port';
import { BrokerMqttHandler } from './mqtt/handler';
import { buildServer } from './server';

const { config, warnings } = loadConfig(process.env);
const registry = config.mqtt.enabled
  ? new BrokerRegistry({ shared: config.mqtt.shared, idleMs: config.mqtt.idleMs })
  : undefined;
const app = buildServer({
  config,
  logger: true,
  ...(registry ? { mqtt: new BrokerMqttHandler(registry) } : {}),
});
for (const w of warnings) app.log.warn(w);
if (registry) registry.log = app.log;

let debugPort: DebugPort | undefined;
const shutdown = async () => {
  await app.close();
  await debugPort?.close();
  await registry?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
if (registry && config.mqtt.debugPort) {
  debugPort = await startDebugPort({ port: config.mqtt.debugPort, registry, log: app.log });
  app.log.info(`MQTT debug port on 127.0.0.1:${debugPort.port} (username = namespace)`);
}
