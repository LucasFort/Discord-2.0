/**
 * App de computador do Nexo (Electron).
 * Abre o site do Nexo numa janela própria e adiciona o que o navegador não faz sozinho:
 * - seletor de tela/janela com miniaturas para a transmissão;
 * - áudio do sistema na transmissão (Windows);
 * - links externos abrem no navegador padrão;
 * - uma janela só (abrir de novo traz a janela existente para a frente);
 * - atalhos globais de mutar e ensurdecer (funcionam com o jogo em foco);
 * - som do computador na transmissão SEM o som do próprio Nexo (Windows 11), para quem assiste
 *   não ouvir a própria voz de volta;
 * - atualização automática (baixa a versão nova sozinho e pergunta se pode reiniciar).
 */
const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, session, shell } = require('electron');
const os = require('node:os');
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
  win.on('closed', () => {
    win = null;
    stopSystemAudio();
  });
  // Página recarregou (atualização do site): a captura antiga não tem mais quem a ouça.
  win.webContents.on('did-start-navigation', (d) => d.isMainFrame && !d.isSameDocument && stopSystemAudio());

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
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopSystemAudio();
});

const fromNexo = (e) => !!win && e.sender === win.webContents && e.sender.getURL().startsWith(APP_ORIGIN);

// Som do computador para a transmissão, tirando o som do Nexo (vozes da call e transmissões
// dos outros). Usa a captura por processo do Windows (WASAPI "exclude process tree"), que só
// existe a partir do build 20348 (Windows 11). Sem ela o site usa a captura normal do Electron.
let LoopbackCapture;
function loadLoopback() {
  if (LoopbackCapture !== undefined) return LoopbackCapture;
  LoopbackCapture = null;
  const build = Number(os.release().split('.')[2] || 0);
  if (process.platform !== 'win32' || process.arch !== 'x64' || build < 20348) return null;
  try {
    LoopbackCapture = require('loopback-capture').LoopbackCapture;
  } catch (err) {
    console.error('loopback-capture indisponível', err);
  }
  return LoopbackCapture;
}
let capture = null;
function stopSystemAudio() {
  if (!capture) return;
  try {
    capture.stop();
  } catch {}
  capture = null;
}
ipcMain.handle('sysaudio:available', (e) => fromNexo(e) && !!loadLoopback());
ipcMain.handle('sysaudio:start', (e) => {
  if (!fromNexo(e) || !loadLoopback()) return false;
  stopSystemAudio();
  const target = e.sender;
  try {
    const c = new LoopbackCapture();
    // process.pid = este processo e todos os filhos (janela, áudio da call): tudo do Nexo fica de fora.
    c.startSystemAudio((chunk) => {
      if (capture === c && !target.isDestroyed()) target.send('sysaudio:chunk', chunk);
    }, process.pid);
    capture = c;
    return true;
  } catch (err) {
    console.error('Falha ao capturar o som do sistema', err);
    stopSystemAudio();
    return false;
  }
});
ipcMain.handle('sysaudio:stop', (e) => {
  if (fromNexo(e)) stopSystemAudio();
});

// Atualização automática: confere ao abrir e a cada 2 horas; a versão nova é baixada em segundo
// plano e instalada ao reiniciar (ou ao fechar o app, se a pessoa escolher "Depois").
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    return console.error('electron-updater indisponível', err);
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => console.error('Atualização falhou', err?.message || err));
  let asked = false;
  autoUpdater.on('update-downloaded', async (info) => {
    if (asked) return;
    asked = true;
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'info',
      title: 'Atualização do Nexo',
      message: `A versão ${info.version} do Nexo foi baixada.`,
      detail: 'Reiniciar agora para atualizar? Se escolher "Depois", ela é instalada quando você fechar o app.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      stopSystemAudio();
      autoUpdater.quitAndInstall();
    }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 2 * 60 * 60 * 1000);
}

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
  setupAutoUpdate();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
