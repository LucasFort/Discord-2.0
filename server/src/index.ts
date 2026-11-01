import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { registerGateway } from './gateway.js';
import { registerRoutes } from './routes.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(cors, { origin: true });
await app.register(websocket);

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join('; ') });
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  return reply.code(status).send({ error: status >= 500 ? 'Erro interno' : (err as Error).message });
});

registerGateway(app);
registerRoutes(app);
app.get('/api/health', async () => ({ ok: true }));

await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' });
