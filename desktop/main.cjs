/**
 * App de computador do Nexo (Electron).
 * Abre o site do Nexo numa janela própria e adiciona o que o navegador não faz sozinho:
 * - seletor de tela/janela com miniaturas para a transmissão;
 * - áudio do sistema na transmissão (Windows);
 * - links externos abrem no navegador padrão;
 * - uma janela só (abrir de novo traz a janela existente para a frente);
 * - atalhos globais de mutar e ensurdecer (funcionam com o jogo em foco).
 */
const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session, shell } = require('electron');
const path = require('node:path');

const APP_URL = process.env.NEXO_URL || require('./package.json').nexoUrl;
const APP_ORIGIN = new URL(APP_URL).origin;

let win = null;

// Quando um jogo em tela cheia cobre o Nexo, o Windows avisa que a janela está "escondida" e o
// Chromium desacelera a página, e a transmissão e as chamadas travam. Desliga essa economia.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#0f1218',
    title: 'Nexo',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-main.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadURL(APP_URL);
  win.on('closed', () => (win = null));

  // Links de fora do Nexo abrem no navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_ORIGIN)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Site fora do ar (Render acordando): tenta de novo em 5 s em vez de ficar numa tela branca.
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) setTimeout(() => win && win.loadURL(url || APP_URL), 5000);
  });
}

/** Abre a janelinha com miniaturas das telas e janelas; devolve a fonte escolhida (ou null). */
function pickSource(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win ?? undefined,
      modal: !!win,
      width: 760,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Escolha o que transmitir',
      backgroundColor: '#171b24',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload-picker.cjs'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler('picker:sources');
      ipcMain.removeAllListeners('picker:choose');
      resolve(sources.find((s) => s.id === id) ?? null);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.handle('picker:sources', () =>
      sources.map((s) => ({
        id: s.id,
        name: s.name,
        screen: s.id.startsWith('screen:'),
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      })),
    );
    ipcMain.on('picker:choose', (_e, id) => finish(id));
    picker.on('closed', () => finish(null));
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

// Atalhos globais pedidos pelo site (Configurações > Voz > Atalhos).
ipcMain.handle('shortcuts:set', (e, keys) => {
  if (!win || e.sender !== win.webContents || !e.sender.getURL().startsWith(APP_ORIGIN)) return { mute: false, deafen: false };
  globalShortcut.unregisterAll();
  const result = { mute: false, deafen: false };
  for (const name of ['mute', 'deafen']) {
    const accel = typeof keys?.[name] === 'string' ? keys[name] : '';
    if (!accel) continue;
    try {
      result[name] = globalShortcut.register(accel, () => win && win.webContents.send('shortcut', name));
    } catch {
      result[name] = false; // atalho inválido ou já usado por outro programa: o site trata com a janela em foco
    }
  }
  return result;
});
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  const ses = session.defaultSession;

  // Microfone, câmera, notificações e tela só para o próprio Nexo.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const fromNexo = (details.requestingUrl || wc.getURL()).startsWith(APP_ORIGIN);
    callback(fromNexo && ['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });

  // getDisplayMedia (botão "Transmitir tela") passa por aqui no Electron.
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        });
        const chosen = await pickSource(sources);
        if (!chosen) return callback({});
        // No Windows o Electron captura o som do sistema ("loopback"); no Mac/Linux vai só o vídeo.
        const audio = request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined;
        callback(audio ? { video: chosen, audio } : { video: chosen });
      } catch (e) {
        console.error(e);
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
