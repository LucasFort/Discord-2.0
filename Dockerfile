# Um único serviço: a API (Fastify) também entrega o site compilado.
FROM node:22-slim
WORKDIR /app

COPY server/package*.json server/
COPY web/package*.json web/
RUN npm --prefix server ci && npm --prefix web ci

COPY server server
COPY web web
RUN npm --prefix web run build

ENV NODE_ENV=production PORT=3001 DB_PATH=/data/discord2.db
RUN mkdir -p /data
EXPOSE 3001
CMD ["npm", "--prefix", "server", "start"]
