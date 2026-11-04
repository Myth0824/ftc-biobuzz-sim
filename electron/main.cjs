const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Enable WebGL and GPU acceleration — required for Three.js
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
// Allow localhost dev server without CORS issues
app.commandLine.appendSwitch('disable-web-security');

// Keep a global reference so the window isn't garbage collected
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'BIOBUZZ Simulator',
    backgroundColor: '#14171c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Required for WebGL / Three.js
      experimentalFeatures: true,
      // Required for Gamepad API
      navigateOnDragDrop: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  // Load the sim page from the Vite dev server
  const port = process.env.VITE_PORT || '5888';
  win.loadURL(`http://localhost:${port}/sim/`);

  // Show once ready — avoids white flash
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // Open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
