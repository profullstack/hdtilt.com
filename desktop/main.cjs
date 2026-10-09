// hdtilt desktop: the same server and web app, on 127.0.0.1, in a window.
// Running the server here means streams go straight from the provider to
// this machine (no hosted proxy), and LAN tuners work.

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');

let win;

async function start() {
  process.env.HDTILT_WEB_DIR ||= path.join(__dirname, '..', 'web', 'dist');
  const { startServer } = await import(path.join(__dirname, '..', 'src', 'server', 'server.js'));
  const server = await startServer({ port: 0, host: '127.0.0.1', public: false });
  const { port } = server.address();

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    backgroundColor: '#0b0f14',
    title: 'hdtilt',
    icon: path.join(__dirname, '..', 'web', 'dist', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links out (GitHub, docs) open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
