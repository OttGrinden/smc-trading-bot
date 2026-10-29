#!/usr/bin/env node
/**
 * discord_notify.mjs — fire-and-forget Discord webhook notifier.
 * Uses only Node built-ins (https). Never throws — fail-soft always.
 *
 * Usage (programmatic):
 *   import { discordNotify } from './discord_notify.mjs';
 *   await discordNotify('message text');
 *
 * Usage (CLI):
 *   node discord_notify.mjs "message text"
 */

import https from 'https';

const WEBHOOK_URL = 'https://discord.com/api/webhooks/REDACTED_WEBHOOK_ID/REDACTED_WEBHOOK_TOKEN';

export async function discordNotify(content) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ content: String(content).slice(0, 2000) });
      const url  = new URL(WEBHOOK_URL);
      const req  = https.request({
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

// CLI mode
if (process.argv[2]) {
  const status = await discordNotify(process.argv[2]);
  process.stderr.write(JSON.stringify({ info: 'discord_notify', status }) + '\n');
}
