import { api } from './api';
import { getSettings } from './settings';

/**
 * Avisos com o Nexo fechado (Web Push). Funciona no Chrome, Edge e Firefox no computador e no Android.
 * No iPhone só funciona com o Nexo adicionado à Tela de Início (iOS 16.4 ou mais novo).
 * O app de computador não precisa: ele fica na bandeja e avisa sozinho.
 */
const isElectron = /Electron\//.test(navigator.userAgent);
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export type PushSupport = 'ok' | 'desktop-app' | 'ios-install' | 'unsupported';
export function pushSupport(): PushSupport {
  if (isElectron) return 'desktop-app';
  if (isIos && !standalone) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined' || !isSecureContext) return 'unsupported';
  return 'ok';
}

let reg: Promise<ServiceWorkerRegistration> | null = null;
function registration() {
  if (!reg) reg = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
  return reg;
}

/** Registra o service worker e trata o clique no aviso (abre o canal). Chamar uma vez ao entrar. */
let started = false;
export function initPush(openUrl: (url: string) => void) {
  if (pushSupport() !== 'ok' || started) return;
  started = true;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'nexo:open' && typeof e.data.url === 'string') openUrl(e.data.url);
  });
  void syncPush();
}

function keyBytes(base64url: string) {
  const b = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const prefs = () => {
  const s = getSettings();
  return { mode: s.desktopNotify === 'all' ? 'all' : 'mentions', hide_content: s.streamerMode || s.pushHideContent };
};

/** Liga os avisos neste aparelho (precisa vir de um clique, por causa da permissão). */
export async function enablePush(): Promise<'ok' | 'denied' | 'unsupported' | 'error'> {
  if (pushSupport() !== 'ok') return 'unsupported';
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') return 'denied';
  try {
    const r = await registration();
    const { key } = await api<{ key: string }>('GET', '/push/key');
    let sub = await r.pushManager.getSubscription();
    // Chave do servidor mudou: a inscrição antiga não serve mais.
    const current = sub?.options.applicationServerKey;
    if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))) !== btoa(String.fromCharCode(...keyBytes(key)))) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await api('POST', '/push/subscribe', { subscription: sub.toJSON(), ...prefs() });
    return 'ok';
  } catch (e) {
    console.warn('push', e);
    return 'error';
  }
}

/** Desliga neste aparelho. */
export async function disablePush() {
  if (pushSupport() !== 'ok') return;
  try {
    const r = await registration();
    const sub = await r.pushManager.getSubscription();
    if (!sub) return;
    await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  } catch {
    /* sem service worker */
  }
}

/** Manda de novo a inscrição com as preferências atuais (ao entrar e quando mudam as configurações). */
export async function syncPush() {
  if (pushSupport() !== 'ok') return;
  const s = getSettings();
  if (!s.pushEnabled || s.desktopNotify === 'off' || Notification.permission !== 'granted') {
    if (!s.pushEnabled || s.desktopNotify === 'off') await disablePush();
    return;
  }
  await enablePush();
}
