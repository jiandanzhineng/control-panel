const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

function getTrayIconPath() {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'assets', 'icon.ico');
  }
  return path.join(__dirname, '..', 'assets', 'icon.ico');
}

function createAppTray({ onShow, onQuit, labels = {} }) {
  let image = nativeImage.createFromPath(getTrayIconPath());
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(process.execPath);
  }
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('UnderSilicon');
  const applyLabels = (next = {}) => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: next.showWindow || '显示主窗口', click: onShow },
      { type: 'separator' },
      { label: next.quit || '退出', click: onQuit },
    ]));
  };
  applyLabels(labels);
  tray.on('click', onShow);
  tray.setLabels = applyLabels;
  return tray;
}

module.exports = { createAppTray, getTrayIconPath };
