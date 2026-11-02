import { getSettings } from './settings';

/** Fica true enquanto a pessoa está numa call (jogando com o Nexo atrás não conta como "parado"). */
let inCall = false;
export const setInCall = (v: boolean) => void (inCall = v);

type DesktopIdle = { idleSeconds?: () => Promise<number> };
const desktop = (window as unknown as { nexoDesktop?: DesktopIdle }).nexoDesktop;

const IDLE_MS = 10 * 60_000;

/**
 * "Ausente" automático, como no Discord: 10 minutos sem mexer no computador.
 * No app de computador usa o tempo parado do sistema inteiro (mexer em outro programa conta);
 * no navegador, só o que acontece na aba do Nexo.
 */
export function startIdleWatch(send: (idle: boolean) => void) {
  let lastInput = Date.now();
  let idle = false;
  const set = (v: boolean) => {
    if (v === idle) return;
    idle = v;
    send(v);
  };
  const onInput = () => {
    lastInput = Date.now();
    set(false);
  };
  const events = ['pointermove', 'keydown', 'pointerdown', 'wheel'] as const;
  events.forEach((ev) => window.addEventListener(ev, onInput, { passive: true }));
  const timer = setInterval(async () => {
    if (!getSettings().autoIdle || inCall) return set(false);
    if (desktop?.idleSeconds) {
      const secs = await desktop.idleSeconds().catch(() => 0);
      return set(secs * 1000 > IDLE_MS);
    }
    set(Date.now() - lastInput > IDLE_MS);
  }, 30_000);
  return () => {
    clearInterval(timer);
    events.forEach((ev) => window.removeEventListener(ev, onInput));
  };
}
