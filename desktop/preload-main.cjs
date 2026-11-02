// Ponte entre o site do Nexo e o app de computador: atalhos globais de mutar e ensurdecer.
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
});
