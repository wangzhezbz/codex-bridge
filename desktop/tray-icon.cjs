"use strict";

const MAC_TRAY_ICON_SIZE = 16;

function createTrayIcon({ platform = process.platform, iconPath, nativeImage } = {}) {
  if (platform !== "darwin") {
    return iconPath;
  }

  const trayIcon = nativeImage.createFromPath(iconPath).resize({
    width: MAC_TRAY_ICON_SIZE,
    height: MAC_TRAY_ICON_SIZE,
    quality: "best",
  });
  trayIcon.setTemplateImage(true);
  return trayIcon;
}

module.exports = {
  MAC_TRAY_ICON_SIZE,
  createTrayIcon,
};
