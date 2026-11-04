import { all, channelsOf, getGuild, membersOf, DEFAULT_EVERYONE_PERMS, type Guild } from './db.js';

/**
 * Permissões no estilo do Discord: cada cargo tem um conjunto de bits.
 * O cargo @everyone tem o mesmo id do servidor e vale para todo mundo.
 * Cada canal pode ter "sobrescritas" por cargo (permitir ou negar bits só naquele canal).
 * O mesmo arquivo existe em web/src/permissions.ts: mude os dois juntos.
 */
export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  ATTACH_FILES: 1 << 2,
  ADD_REACTIONS: 1 << 3,
  MANAGE_MESSAGES: 1 << 4,
  CONNECT: 1 << 5,
  SPEAK: 1 << 6,
  STREAM: 1 << 7,
  CREATE_INVITE: 1 << 8,
  MANAGE_CHANNELS: 1 << 9,
  MANAGE_ROLES: 1 << 10,
  MANAGE_GUILD: 1 << 11,
  KICK_MEMBERS: 1 << 12,
  MUTE_MEMBERS: 1 << 13,
  MOVE_MEMBERS: 1 << 14,
  ADMINISTRATOR: 1 << 15,
} as const;
export const ALL_PERMS = (1 << 16) - 1;
/** Bits que fazem sentido por canal (os outros só valem no servidor todo). */
export const CHANNEL_PERMS =
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS | P.MANAGE_MESSAGES | P.CONNECT | P.SPEAK | P.STREAM;
/** O que todo mundo pode num servidor novo (igual ao comportamento de antes dos cargos). */
export const DEFAULT_PERMS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS | P.CONNECT | P.SPEAK | P.STREAM | P.CREATE_INVITE;
if (DEFAULT_PERMS !== DEFAULT_EVERYONE_PERMS) throw new Error("DEFAULT_EVERYONE_PERMS desatualizado em db.ts");
/** Conversa direta: as duas pessoas falam, mandam arquivos e ligam, mas não administram nada. */
export const DM_PERMS = DEFAULT_PERMS & ~P.CREATE_INVITE;

export type Role = { id: string; guild_id: string; name: string; color: string | null; permissions: number; position: number; hoist: number };
export type Overwrite = { id: string; allow: number; deny: number };

export type PermInput = {
  guildId: string;
  ownerId: string;
  isDm: boolean;
  roles: Pick<Role, 'id' | 'permissions' | 'position'>[];
  memberRoles: string[]; // cargos da pessoa (sem o @everyone)
  userId: string;
};

/** Permissões no servidor todo. */
export function basePerms(x: PermInput): number {
  if (x.isDm) return DM_PERMS;
  if (x.userId === x.ownerId) return ALL_PERMS;
  let p = 0;
  for (const r of x.roles) if (r.id === x.guildId || x.memberRoles.includes(r.id)) p |= Number(r.permissions);
  return p & P.ADMINISTRATOR ? ALL_PERMS : p;
}

/** Permissões num canal: primeiro a sobrescrita do @everyone, depois a soma das dos cargos da pessoa. */
export function channelPerms(x: PermInput, overwrites: Overwrite[] = []): number {
  let p = basePerms(x);
  if (x.isDm || p & P.ADMINISTRATOR) return p;
  const everyone = overwrites.find((o) => o.id === x.guildId);
  if (everyone) p = (p & ~Number(everyone.deny)) | Number(everyone.allow);
  let allow = 0;
  let deny = 0;
  for (const o of overwrites)
    if (o.id !== x.guildId && x.memberRoles.includes(o.id)) {
      allow |= Number(o.allow);
      deny |= Number(o.deny);
    }
  p = (p & ~deny) | allow;
  // Sem ver o canal, nada mais vale nele.
  return p & P.VIEW_CHANNEL ? p : 0;
}

/** Posição do cargo mais alto (o dono fica acima de todos). Serve para a hierarquia. */
export function topPosition(x: PermInput): number {
  if (x.isDm) return 0;
  if (x.userId === x.ownerId) return Infinity;
  let top = 0;
  for (const r of x.roles) if (x.memberRoles.includes(r.id)) top = Math.max(top, Number(r.position));
  return top;
}

export type PermContext = Awaited<ReturnType<typeof permContext>>;

/** Carrega tudo de que as permissões de um servidor dependem (4 consultas) e responde perguntas sobre elas. */
export async function permContext(guildOrId: string | Guild) {
  const guild = typeof guildOrId === 'string' ? await getGuild(guildOrId) : guildOrId;
  if (!guild) return undefined;
  const isDm = !!Number(guild.is_dm ?? 0);
  const [roles, memberRows, owRows, memberList] = await Promise.all([
    isDm ? [] : (all('SELECT id, guild_id, name, color, permissions, position, hoist FROM roles WHERE guild_id = ? ORDER BY position DESC', guild.id) as Promise<Role[]>),
    isDm ? [] : all('SELECT user_id, role_id FROM member_roles WHERE guild_id = ?', guild.id),
    isDm ? [] : all('SELECT o.channel_id, o.target_id, o.allow, o.deny FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = ?', guild.id),
    all('SELECT user_id FROM members WHERE guild_id = ?', guild.id),
  ]);
  for (const r of roles) {
    r.permissions = Number(r.permissions);
    r.position = Number(r.position);
    r.hoist = Number(r.hoist ?? 0);
  }
  const members = new Set(memberList.map((m) => m.user_id as string));
  const memberRoles = new Map<string, string[]>();
  for (const r of memberRows) {
    const list = memberRoles.get(r.user_id) ?? [];
    list.push(r.role_id);
    memberRoles.set(r.user_id, list);
  }
  const overwrites = new Map<string, Overwrite[]>();
  for (const o of owRows) {
    const list = overwrites.get(o.channel_id) ?? [];
    list.push({ id: o.target_id, allow: Number(o.allow), deny: Number(o.deny) });
    overwrites.set(o.channel_id, list);
  }
  const input = (userId: string): PermInput => ({ guildId: guild.id, ownerId: guild.owner_id, isDm, roles, memberRoles: memberRoles.get(userId) ?? [], userId });
  const perms = (userId: string, channelId?: string) => {
    if (!members.has(userId)) return 0;
    return channelId ? channelPerms(input(userId), overwrites.get(channelId)) : basePerms(input(userId));
  };
  return {
    guild,
    isDm,
    roles,
    members,
    memberRoles,
    overwrites,
    perms,
    can: (userId: string, perm: number, channelId?: string) => (perms(userId, channelId) & perm) === perm,
    top: (userId: string) => topPosition(input(userId)),
    isOwner: (userId: string) => !isDm && guild.owner_id === userId,
    /** Quem pode mexer em quem: o dono em todos; os outros só em quem tem cargo mais baixo. */
    outranks: (userId: string, targetId: string) =>
      !isDm && targetId !== guild.owner_id && (userId === guild.owner_id || topPosition(input(userId)) > topPosition(input(targetId))),
  };
}

/**
 * Servidor completo como uma pessoa vê: só os canais que ela pode ver, os cargos,
 * os cargos de cada membro e as sobrescritas de cada canal (o site calcula as permissões com isso).
 */
export async function guildPayload(g: Guild, viewerId: string, ctx?: PermContext) {
  const c = ctx ?? (await permContext(g))!;
  const [channels, members] = await Promise.all([channelsOf(g.id), membersOf(g.id)]);
  return {
    ...g,
    channels: channels.filter((ch) => c.can(viewerId, P.VIEW_CHANNEL, ch.id)).map((ch) => ({ ...ch, overwrites: c.overwrites.get(ch.id) ?? [] })),
    members,
    roles: c.roles,
    member_roles: Object.fromEntries(c.memberRoles),
  };
}

/** Canal com as sobrescritas (como vai para o site). */
export const channelWithOverwrites = <T extends { id: string }>(ch: T, ctx: PermContext) => ({ ...ch, overwrites: ctx!.overwrites.get(ch.id) ?? [] });
