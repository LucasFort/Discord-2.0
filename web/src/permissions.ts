import type { Guild } from './api';

/**
 * Permissões no estilo do Discord (cópia de server/src/permissions.ts: mude os dois juntos).
 * O servidor é quem decide de verdade; aqui serve para mostrar ou esconder botões.
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


const input = (g: Guild, userId: string): PermInput => ({
  guildId: g.id,
  ownerId: g.owner_id,
  isDm: !!Number(g.is_dm ?? 0),
  roles: g.roles ?? [],
  memberRoles: g.member_roles?.[userId] ?? [],
  userId,
});
/** Permissões de alguém no servidor (ou num canal dele). */
export function permsOf(g: Guild | undefined, userId: string | undefined, channelId?: string): number {
  if (!g || !userId) return 0;
  const x = input(g, userId);
  if (!channelId) return basePerms(x);
  return channelPerms(x, g.channels.find((c) => c.id === channelId)?.overwrites);
}
export const can = (g: Guild | undefined, userId: string | undefined, perm: number, channelId?: string) => (permsOf(g, userId, channelId) & perm) === perm;
export const topOf = (g: Guild, userId: string) => topPosition(input(g, userId));
/** Quem pode mexer em quem (expulsar, moderar): o dono em todos; os outros só em quem está abaixo. */
export const outranks = (g: Guild, userId: string, targetId: string) =>
  !Number(g.is_dm ?? 0) && targetId !== g.owner_id && (userId === g.owner_id || topOf(g, userId) > topOf(g, targetId));
/** Cargos de alguém, do mais alto para o mais baixo (sem o @everyone). */
export const rolesOf = (g: Guild | undefined, userId: string): Role[] =>
  !g ? [] : (g.roles ?? []).filter((r) => g.member_roles?.[userId]?.includes(r.id)).sort((a, b) => b.position - a.position);
/** Cor do nome: a do cargo colorido mais alto. */
export const nameColor = (g: Guild | undefined, userId: string) => rolesOf(g, userId).find((r) => r.color)?.color ?? undefined;
/** Abre alguma parte das configurações do servidor? */
export const MANAGE_ANY = P.MANAGE_GUILD | P.MANAGE_CHANNELS | P.MANAGE_ROLES | P.KICK_MEMBERS;
export const canAny = (g: Guild | undefined, userId: string | undefined, perms: number) => (permsOf(g, userId) & perms) !== 0;

/** Nomes e explicações das permissões, na ordem da tela. */
export const PERM_INFO: { group: string; items: [number, string, string][] }[] = [
  {
    group: 'Servidor',
    items: [
      [P.VIEW_CHANNEL, 'Ver canais', 'Ver os canais de texto e de voz (sem isso, a pessoa não vê nada).'],
      [P.MANAGE_CHANNELS, 'Gerenciar canais', 'Criar, renomear, apagar canais e mudar quem pode ver cada um.'],
      [P.MANAGE_ROLES, 'Gerenciar cargos', 'Criar e editar cargos abaixo do seu e dar esses cargos às pessoas.'],
      [P.MANAGE_GUILD, 'Gerenciar servidor', 'Mudar o nome e o ícone do servidor.'],
      [P.CREATE_INVITE, 'Criar convite', 'Gerar links para chamar gente nova.'],
      [P.KICK_MEMBERS, 'Expulsar membros', 'Tirar do servidor quem tem cargo mais baixo.'],
    ],
  },
  {
    group: 'Texto',
    items: [
      [P.SEND_MESSAGES, 'Enviar mensagens', 'Escrever nos canais de texto.'],
      [P.ATTACH_FILES, 'Anexar arquivos', 'Mandar imagens, vídeos e outros arquivos.'],
      [P.ADD_REACTIONS, 'Adicionar reações', 'Reagir às mensagens com emoji.'],
      [P.MANAGE_MESSAGES, 'Gerenciar mensagens', 'Apagar e fixar mensagens de outras pessoas.'],
    ],
  },
  {
    group: 'Voz',
    items: [
      [P.CONNECT, 'Conectar', 'Entrar nos canais de voz.'],
      [P.SPEAK, 'Falar', 'Usar o microfone na call.'],
      [P.STREAM, 'Vídeo e transmissão', 'Ligar a câmera e transmitir a tela.'],
      [P.MUTE_MEMBERS, 'Silenciar membros', 'Silenciar e ensurdecer pessoas no servidor.'],
      [P.MOVE_MEMBERS, 'Mover membros', 'Mover pessoas entre canais de voz e desconectar da call.'],
    ],
  },
  {
    group: 'Avançado',
    items: [[P.ADMINISTRATOR, 'Administrador', 'Tem todas as permissões e ignora as restrições dos canais. Cuidado ao dar.']],
  },
];
/** Permissões que aparecem na tela de permissões de um canal de texto ou de voz. */
export const CHANNEL_PERM_LIST = (type: 'text' | 'voice') =>
  PERM_INFO.flatMap((g) => g.items).filter(([bit]) =>
    bit === P.VIEW_CHANNEL || (type === 'text' ? [P.SEND_MESSAGES, P.ATTACH_FILES, P.ADD_REACTIONS, P.MANAGE_MESSAGES] : [P.CONNECT, P.SPEAK, P.STREAM]).includes(bit as never),
  );
