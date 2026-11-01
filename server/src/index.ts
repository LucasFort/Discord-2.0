import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Em produção a própria API entrega o site já compilado (web/dist), num único serviço.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/gateway')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Não encontrado' });
  });
}

await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' });
