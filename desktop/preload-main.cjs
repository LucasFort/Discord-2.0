// Ponte entre o site do Nexo e o app de computador: atalhos globais e som do sistema para a transmissão.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexoDesktop', {
  /** Registra os atalhos globais (formato Electron, '' = nenhum). Devolve quais deram certo. */
  setShortcuts: (s) => ipcRenderer.invoke('shortcuts:set', { mute: String(s?.mute ?? ''), deafen: String(s?.deafen ?? '') }),
  /** Avisa quando um atalho global é apertado ('mute' ou 'deafen'). Devolve a função para parar de ouvir. */
  onShortcut: (cb) => {
    const fn = (_e, name) => cb(name);
    ipcRenderer.on('shortcut', fn);
    return () => ipcRenderer.removeListener('shortcut', fn);
  },
  /** Opções do Windows: abrir com o computador, fechar para a bandeja, começar minimizado. */
  setAppSettings: (s) => ipcRenderer.send('app:settings', { openAtLogin: !!s?.openAtLogin, minimizeToTray: !!s?.minimizeToTray, startMinimized: !!s?.startMinimized }),
  /** Segundos sem mexer no teclado e mouse (no computador inteiro). */
  idleSeconds: () => ipcRenderer.invoke('app:idle-seconds'),
  /** Som do computador sem o som do próprio Nexo (Windows 11). PCM 16 bits, estéreo, 48 kHz. */
  systemAudio: {
    available: () => ipcRenderer.invoke('sysaudio:available'),
    start: () => ipcRenderer.invoke('sysaudio:start'),
    stop: () => ipcRenderer.invoke('sysaudio:stop'),
    onChunk: (cb) => {
      const fn = (_e, chunk) => cb(chunk);
      ipcRenderer.on('sysaudio:chunk', fn);
      return () => ipcRenderer.removeListener('sysaudio:chunk', fn);
    },
  },
});
