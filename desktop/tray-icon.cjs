"use strict";

const MAC_TRAY_ICON_SIZE = 16;

function fillRect(alpha, width, x, y, rectWidth, rectHeight) {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let column = x; column < x + rectWidth; column += 1) {
      alpha[(row * width) + column] = 255;
    }
  }
}

function macTrayAlphaMask() {
  const alpha = new Uint8Array(MAC_TRAY_ICON_SIZE * MAC_TRAY_ICON_SIZE);

  fillRect(alpha, MAC_TRAY_ICON_SIZE, 2, 3, 5, 2);
  fillRect(alpha, MAC_TRAY_ICON_SIZE, 1, 4, 2, 8);
  fillRect(alpha, MAC_TRAY_ICON_SIZE, 2, 11, 5, 2);

  fillRect(alpha, MAC_TRAY_ICON_SIZE, 9, 3, 2, 10);
  fillRect(alpha, MAC_TRAY_ICON_SIZE, 10, 3, 3, 2);
  fillRect(alpha, MAC_TRAY_ICON_SIZE, 10, 7, 3, 2);
  fillRect(alpha, MAC_TRAY_ICON_SIZE, 10, 11, 3, 2);
  fillRect(alpha, MAC_TRAY_ICON_SIZE, 13, 4, 2, 4);
  fillRect(alpha, MAC_TRAY_ICON_SIZE, 13, 8, 2, 4);

  return alpha;
}

function templateBitmap(alpha, width, scale = 1) {
  const scaledWidth = width * scale;
  const bitmap = Buffer.alloc(scaledWidth * scaledWidth * 4);
  for (let y = 0; y < scaledWidth; y += 1) {
    for (let x = 0; x < scaledWidth; x += 1) {
      const sourceAlpha = alpha[(Math.floor(y / scale) * width) + Math.floor(x / scale)];
      const offset = ((y * scaledWidth) + x) * 4;
      bitmap[offset] = 255;
      bitmap[offset + 1] = 255;
      bitmap[offset + 2] = 255;
      bitmap[offset + 3] = sourceAlpha;
    }
  }
  return bitmap;
}

function createTrayIcon({ platform = process.platform, iconPath, nativeImage } = {}) {
  if (platform !== "darwin") {
    return iconPath;
  }

  const alpha = macTrayAlphaMask();
  const trayIcon = nativeImage.createFromBitmap(
    templateBitmap(alpha, MAC_TRAY_ICON_SIZE),
    {
      width: MAC_TRAY_ICON_SIZE,
      height: MAC_TRAY_ICON_SIZE,
      scaleFactor: 1,
    },
  );
  trayIcon.addRepresentation({
    scaleFactor: 2,
    width: MAC_TRAY_ICON_SIZE * 2,
    height: MAC_TRAY_ICON_SIZE * 2,
    buffer: templateBitmap(alpha, MAC_TRAY_ICON_SIZE, 2),
  });
  trayIcon.setTemplateImage(true);
  return trayIcon;
}

module.exports = {
  MAC_TRAY_ICON_SIZE,
  createTrayIcon,
};
