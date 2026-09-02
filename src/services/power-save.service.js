class PowerSaveService {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.blockerApi = options.blockerApi || null;
    this.logger = options.logger || console;
    this.blockerId = null;
    this.captureLeases = new Set();
    this.recordingLease = null;
  }

  acquireCaptureLease() {
    if (this.platform !== 'win32') return null;

    const lease = Symbol('audio-capture');
    if (this.captureLeases.size === 0) {
      const blocker = this._getBlockerApi();
      try {
        this.blockerId = blocker.start('prevent-display-sleep');
        this.logger.debug('Windows display sleep blocked for audio capture');
      } catch (error) {
        this.logger.warn('Failed to block Windows display sleep', { error: error.message });
        return null;
      }
    }

    this.captureLeases.add(lease);
    return lease;
  }

  releaseCaptureLease(lease) {
    if (!lease || !this.captureLeases.delete(lease)) return;
    if (this.captureLeases.size === 0) {
      this._stopBlocker();
    }
  }

  beginRecording() {
    if (!this.recordingLease) {
      this.recordingLease = this.acquireCaptureLease();
    }
    return this.recordingLease;
  }

  endRecording() {
    if (!this.recordingLease) return;
    this.releaseCaptureLease(this.recordingLease);
    this.recordingLease = null;
  }

  shutdown() {
    this.captureLeases.clear();
    this.recordingLease = null;
    this._stopBlocker();
  }

  _getBlockerApi() {
    if (!this.blockerApi) {
      this.blockerApi = require('electron').powerSaveBlocker;
    }
    return this.blockerApi;
  }

  _stopBlocker() {
    if (this.blockerId === null) return;
    const blockerId = this.blockerId;
    this.blockerId = null;
    try {
      this._getBlockerApi().stop(blockerId);
      this.logger.debug('Windows display sleep block released');
    } catch (error) {
      this.logger.warn('Failed to release Windows display sleep block', { error: error.message });
    }
  }
}

module.exports = { PowerSaveService };
