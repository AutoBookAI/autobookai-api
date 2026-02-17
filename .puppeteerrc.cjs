/**
 * Puppeteer configuration for Railway deployment.
 * Uses system Chromium installed via nixpacks instead of bundled download.
 */
const { join } = require('path');

module.exports = {
  skipDownload: !!process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD,
};
