const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

function getTrayIconPath() {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'assets', 'icon.ico');
  }
  return path.join(__dirname, '..', 'assets', 'icon.ico');
}

function createAppTray({ onShow, onQuit }) {
  let image = nativeImage.createFromPath(getTrayIconPath());
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(process.execPath);
  }
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('UnderSilicon');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: onShow },
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]));
  tray.on('click', onShow);
  return tray;
}

module.exports = { createAppTray, getTrayIconPath };
