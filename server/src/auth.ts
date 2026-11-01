import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUser, type User } from './db.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-troque-em-producao');

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('30d').sign(secret);
}

export async function userFromToken(token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.sub ? getUser(payload.sub) : undefined;
  } catch {
    return undefined;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

/** preHandler: requires `Authorization: Bearer <token>`. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  const user = await userFromToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!user) return reply.code(401).send({ error: 'Não autenticado' });
  req.user = user;
}
