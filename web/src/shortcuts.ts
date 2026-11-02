import { useEffect, useRef, useState } from 'react';
import { comboFromEvent, comboToAccelerator, getSettings, onSettings } from './settings';

/** Ponte do app de computador (desktop/preload-main.cjs). Não existe no navegador. */
type DesktopBridge = {
  setShortcuts: (s: { mute: string; deafen: string }) => Promise<{ mute: boolean; deafen: boolean }>;
  onShortcut: (cb: (name: 'mute' | 'deafen') => void) => () => void;
};
const desktop = (window as unknown as { nexoDesktop?: DesktopBridge }).nexoDesktop;

/**
 * Se cada atalho virou global (funciona com o jogo em foco). null = navegador (nunca é global).
 * false no app = outro programa já usa a combinação (o Discord usa Ctrl+Shift+M e Ctrl+Shift+D).
 */
export type ShortcutStatus = { mute: boolean; deafen: boolean } | null;
let status: ShortcutStatus = desktop ? { mute: false, deafen: false } : null;
const statusListeners = new Set<(s: ShortcutStatus) => void>();
const setStatus = (s: ShortcutStatus) => {
  status = s;
  statusListeners.forEach((l) => l(s));
};
export function useShortcutStatus() {
  const [s, set] = useState(status);
  useEffect(() => {
    statusListeners.add(set);
    return () => void statusListeners.delete(set);
  }, []);
  return s;
}

/**
 * Atalhos de mutar/desmutar e ensurdecer (como os do Discord).
 * No app de computador viram atalhos globais: funcionam até com o jogo em foco.
 * No navegador funcionam com a aba do Nexo em foco.
 */
export function useVoiceShortcuts(actions: { mute: () => void; deafen: () => void }) {
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    // Atalhos que o app de computador conseguiu registrar como globais (esses o navegador não trata).
    let global = { mute: false, deafen: false };
    const register = () => {
      if (!desktop) return;
      const s = getSettings();
      desktop
        .setShortcuts({ mute: comboToAccelerator(s.muteKey), deafen: comboToAccelerator(s.deafenKey) })
        .then((r) => {
          global = r;
          setStatus(r);
        })
        .catch(() => {
          global = { mute: false, deafen: false };
          setStatus(global);
        });
    };
    register();
    let prev = getSettings();
    const offSettings = onSettings((s) => {
      if (s.muteKey !== prev.muteKey || s.deafenKey !== prev.deafenKey) register();
      prev = s;
    });
    const offDesktop = desktop?.onShortcut((name) => ref.current[name]());

    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      // Tecla sozinha (sem Ctrl/Alt) não conta enquanto a pessoa digita numa caixa de texto.
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
      if (typing && !e.ctrlKey && !e.altKey && !e.metaKey) return;
      const s = getSettings();
      const name = combo === s.muteKey ? 'mute' : combo === s.deafenKey ? 'deafen' : null;
      if (!name || global[name]) return;
      e.preventDefault();
      ref.current[name]();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      offSettings();
      offDesktop?.();
      desktop?.setShortcuts({ mute: '', deafen: '' }).catch(() => {});
    };
  }, []);
}
