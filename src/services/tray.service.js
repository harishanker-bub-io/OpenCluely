const path = require('path');
const fs = require('fs');

class TrayService {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.app = options.app;
    this.Tray = options.Tray;
    this.Menu = options.Menu;
    this.nativeImage = options.nativeImage;
    this.windowManager = options.windowManager;
    this.iconPath = options.iconPath || path.join(__dirname, '..', '..', 'assests', 'icons', 'app-icon.ico');
    this.logger = options.logger || console;
    this.tray = null;
  }

  create() {
    if (this.tray || this.platform !== 'win32') return this.tray;

    try {
      const { Tray, Menu, nativeImage } = this._getElectronDependencies();
      const iconPath = fs.existsSync(this.iconPath)
        ? this.iconPath
        : path.join(path.dirname(this.iconPath), 'terminal.png');
      const icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) {
        throw new Error(`Tray icon could not be loaded: ${iconPath}`);
      }

      this.tray = new Tray(icon);
      this.tray.setToolTip('OpenCluely');
      this.tray.setContextMenu(Menu.buildFromTemplate([
        {
          label: 'Show / Hide',
          click: () => this.windowManager.toggleVisibility(),
        },
        {
          label: 'Open Chat',
          click: () => this.windowManager.showChatWindow(),
        },
        {
          label: 'Settings',
          click: () => this.windowManager.showSettings(),
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => this.app.quit(),
        },
      ]));

      this.tray.on('click', () => this.windowManager.toggleVisibility());
      this.logger.info('Windows tray icon created');
      return this.tray;
    } catch (error) {
      this.logger.warn('Failed to create Windows tray icon', { error: error.message });
      this.tray = null;
      return null;
    }
  }

  destroy() {
    if (!this.tray) return;
    try {
      this.tray.destroy();
    } catch (error) {
      this.logger.warn('Failed to destroy Windows tray icon', { error: error.message });
    } finally {
      this.tray = null;
    }
  }

  _getElectronDependencies() {
    if (this.Tray && this.Menu && this.nativeImage) {
      return {
        Tray: this.Tray,
        Menu: this.Menu,
        nativeImage: this.nativeImage,
      };
    }
    return require('electron');
  }
}

module.exports = { TrayService };
