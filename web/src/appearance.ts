import { getSettings, onSettings, type Settings } from './settings';

type DesktopApp = { setAppSettings?: (s: { openAtLogin: boolean; minimizeToTray: boolean; startMinimized: boolean }) => void };
const desktop = (window as unknown as { nexoDesktop?: DesktopApp }).nexoDesktop;
/** O app de computador instalado sabe guardar as opções do Windows (versão 0.1.4+). */
export const hasDesktopAppSettings = () => !!desktop?.setAppSettings;

const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: light)') : null;

/** Aplica tema, tamanho do texto, zoom e acessibilidade na página inteira. */
function apply(s: Settings) {
  const root = document.documentElement;
  const theme = s.theme === 'system' ? (media?.matches ? 'light' : 'dark') : s.theme;
  root.dataset.theme = theme;
  root.dataset.display = s.messageDisplay;
  root.classList.toggle('reduce-motion', s.reduceMotion);
  root.classList.toggle('hide-chat-avatars', !s.showAvatars);
  root.classList.toggle('desaturate', s.saturation < 100);
  root.style.setProperty('--msg-font', `${s.fontSize}px`);
  root.style.setProperty('--msg-gap', `${s.messageGap}px`);
  root.style.setProperty('--saturation', `${s.saturation / 100}`);
  (root.style as CSSStyleDeclaration & { zoom: string }).zoom = s.zoom === 100 ? '' : `${s.zoom}%`;
  desktop?.setAppSettings?.({ openAtLogin: s.openAtLogin, minimizeToTray: s.minimizeToTray, startMinimized: s.startMinimized });
}

let last = '';
export function startAppearance() {
  const run = (s: Settings) => {
    const key = JSON.stringify([s.theme, s.messageDisplay, s.reduceMotion, s.showAvatars, s.fontSize, s.messageGap, s.saturation, s.zoom, s.openAtLogin, s.minimizeToTray, s.startMinimized, media?.matches]);
    if (key === last) return;
    last = key;
    apply(s);
  };
  run(getSettings());
  onSettings(run);
  media?.addEventListener('change', () => run(getSettings()));
}
