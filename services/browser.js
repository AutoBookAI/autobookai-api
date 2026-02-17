/**
 * Browser automation service — gives Claude step-by-step control
 * over a headless Chromium browser via Puppeteer.
 *
 * Used by services/assistant.js as the `browser_action` tool.
 * Each BrowserSession is scoped to a single handleMessage() call
 * and cleaned up in its finally block.
 */

const puppeteer = require('puppeteer');

// ── Security: URL validation ──────────────────────────────────────────────

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /\.local$/i,
  /\.internal$/i,
];

const BLOCKED_SCHEMES = ['file:', 'data:', 'javascript:', 'ftp:'];

const MAX_ACTIONS_PER_SESSION = 30;
const NAVIGATION_TIMEOUT_MS = 30000;
const PAGE_TEXT_MAX_LENGTH = 8000;

function isUrlAllowed(urlString) {
  try {
    const url = new URL(urlString);
    if (BLOCKED_SCHEMES.includes(url.protocol)) return false;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    for (const pattern of BLOCKED_HOSTS) {
      if (pattern.test(url.hostname)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Browser session ───────────────────────────────────────────────────────

class BrowserSession {
  constructor() {
    this.browser = null;
    this.page = null;
    this.actionCount = 0;
  }

  async init() {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--single-process',
    ];

    const launchOpts = {
      headless: 'new',
      args: launchArgs,
      timeout: 30000,
    };

    // Use system Chromium on Railway (set via PUPPETEER_EXECUTABLE_PATH)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.browser = await puppeteer.launch(launchOpts);
    this.page = await this.browser.newPage();

    await this.page.setViewport({ width: 1280, height: 800 });

    await this.page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Block images, fonts, stylesheets, media for speed
    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  async close() {
    try {
      if (this.browser) await this.browser.close();
    } catch (err) {
      console.error('Browser close error:', err.message);
    }
    this.browser = null;
    this.page = null;
  }

  async getPageState() {
    const title = await this.page.title();
    const url = this.page.url();

    const visibleText = await this.page.evaluate(() => {
      return (document.body?.innerText || '').slice(0, 10000);
    });

    const formFields = await this.page.evaluate(() => {
      const fields = [];
      const inputs = document.querySelectorAll('input, select, textarea');
      for (const el of inputs) {
        if (el.type === 'hidden') continue;
        const label = el.labels?.[0]?.innerText
          || el.getAttribute('aria-label')
          || el.getAttribute('placeholder')
          || el.name
          || '';
        fields.push({
          type: el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : ''),
          label: label.slice(0, 100),
          value: (el.value || '').slice(0, 200),
          selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : null,
        });
      }
      return fields.slice(0, 20);
    });

    const clickables = await this.page.evaluate(() => {
      const items = [];
      const els = document.querySelectorAll('a, button, [role="button"], input[type="submit"]');
      for (const el of els) {
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        if (!text || text.length > 100) continue;
        items.push({
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 100),
          href: el.href || null,
        });
      }
      return items.slice(0, 30);
    });

    return {
      title,
      url,
      visibleText: visibleText.slice(0, PAGE_TEXT_MAX_LENGTH),
      formFields,
      clickables,
    };
  }
}

// ── Action executor ───────────────────────────────────────────────────────

async function executeBrowserAction(session, action, params) {
  session.actionCount++;
  if (session.actionCount > MAX_ACTIONS_PER_SESSION) {
    throw new Error(`Browser session limit reached (${MAX_ACTIONS_PER_SESSION} actions). End this session and start a new one if needed.`);
  }

  switch (action) {
    case 'navigate': {
      const { url } = params;
      if (!url) throw new Error('Missing url for navigate');
      if (!isUrlAllowed(url)) throw new Error(`URL not allowed: ${url}`);
      await session.page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return await session.getPageState();
    }

    case 'click': {
      const { selector, text } = params;
      if (selector) {
        await session.page.click(selector);
      } else if (text) {
        const clicked = await session.page.evaluate((searchText) => {
          const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
          const el = els.find(e =>
            (e.innerText || e.value || '').trim().toLowerCase().includes(searchText.toLowerCase())
          );
          if (el) { el.click(); return true; }
          return false;
        }, text);
        if (!clicked) throw new Error(`No clickable element found with text: "${text}"`);
      } else {
        throw new Error('click requires either selector or text');
      }
      // Wait for potential navigation
      await session.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: NAVIGATION_TIMEOUT_MS,
      }).catch(() => {}); // May not navigate (e.g. modal opens)
      return await session.getPageState();
    }

    case 'type': {
      const { selector, text, value } = params;
      if (!value) throw new Error('Missing value for type action');
      const sel = selector
        || `input[placeholder*="${text}" i], input[name*="${text}" i], textarea[placeholder*="${text}" i]`;
      // Clear existing value first
      await session.page.click(sel).catch(() => {});
      await session.page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) el.value = '';
      }, sel);
      await session.page.type(sel, value, { delay: 50 });
      return { typed: value.length + ' characters', selector: sel };
    }

    case 'select': {
      const { selector, value } = params;
      if (!selector || !value) throw new Error('Missing selector or value for select');
      await session.page.select(selector, value);
      return { selected: value, selector };
    }

    case 'extract': {
      return await session.getPageState();
    }

    case 'wait': {
      const ms = Math.min(params.milliseconds || 2000, 5000);
      await new Promise(r => setTimeout(r, ms));
      return await session.getPageState();
    }

    case 'back': {
      await session.page.goBack({
        waitUntil: 'networkidle2',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return await session.getPageState();
    }

    case 'scroll': {
      const direction = params.direction || 'down';
      await session.page.evaluate((dir) => {
        window.scrollBy(0, dir === 'up' ? -500 : 500);
      }, direction);
      return await session.getPageState();
    }

    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

module.exports = { BrowserSession, executeBrowserAction, isUrlAllowed };
