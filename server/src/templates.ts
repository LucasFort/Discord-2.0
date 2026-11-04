import { P } from './permissions.js';

/**
 * Modelos da tela "Criar servidor" (como no Discord): cada um já vem com canais, tópicos e cargos.
 * Os nomes e descrições aparecem no site (web/src/servers.tsx tem a mesma lista para a prévia).
 */
type TemplateChannel = { name: string; type: 'text' | 'voice'; topic?: string; readOnly?: boolean };
type TemplateRole = { name: string; color: string; permissions: number; hoist?: boolean };
type Template = { channels: TemplateChannel[]; roles: TemplateRole[] };

const MOD = P.MANAGE_MESSAGES | P.KICK_MEMBERS | P.MUTE_MEMBERS | P.MOVE_MEMBERS;

const T = {
  blank: {
    channels: [{ name: 'geral', type: 'text' }, { name: 'Geral', type: 'voice' }],
    roles: [],
  },
  friends: {
    channels: [
      { name: 'geral', type: 'text', topic: 'Papo livre' },
      { name: 'memes', type: 'text', topic: 'Só o que é bom' },
      { name: 'fotos', type: 'text', topic: 'Fotos e vídeos da galera' },
      { name: 'Sala', type: 'voice' },
      { name: 'Jogando', type: 'voice' },
    ],
    roles: [],
  },
  gaming: {
    channels: [
      { name: 'geral', type: 'text' },
      { name: 'clipes', type: 'text', topic: 'Mostre suas melhores jogadas' },
      { name: 'procurando-grupo', type: 'text', topic: 'Chame a galera para jogar' },
      { name: 'Lobby', type: 'voice' },
      { name: 'Partida 1', type: 'voice' },
      { name: 'Partida 2', type: 'voice' },
    ],
    roles: [{ name: 'Moderador', color: '#e74c3c', permissions: MOD, hoist: true }],
  },
  study: {
    channels: [
      { name: 'avisos', type: 'text', topic: 'Provas, prazos e combinados', readOnly: true },
      { name: 'geral', type: 'text' },
      { name: 'duvidas', type: 'text', topic: 'Pergunte à vontade' },
      { name: 'materiais', type: 'text', topic: 'Resumos, links e arquivos' },
      { name: 'Sala de estudo', type: 'voice' },
      { name: 'Foco em silêncio', type: 'voice' },
    ],
    roles: [{ name: 'Monitor', color: '#3498db', permissions: P.MANAGE_MESSAGES, hoist: true }],
  },
  community: {
    channels: [
      { name: 'boas-vindas', type: 'text', topic: 'Diga oi para quem chegou', readOnly: true },
      { name: 'regras', type: 'text', topic: 'Leia antes de participar', readOnly: true },
      { name: 'anuncios', type: 'text', topic: 'Novidades do servidor', readOnly: true },
      { name: 'geral', type: 'text' },
      { name: 'Geral', type: 'voice' },
      { name: 'Eventos', type: 'voice' },
    ],
    roles: [
      { name: 'Admin', color: '#f1c40f', permissions: P.ADMINISTRATOR, hoist: true },
      { name: 'Moderador', color: '#e74c3c', permissions: MOD, hoist: true },
    ],
  },
} satisfies Record<string, Template>;
export const TEMPLATES: Record<keyof typeof T, Template> = T;

export const TEMPLATE_IDS = Object.keys(T) as [keyof typeof T, ...(keyof typeof T)[]];
