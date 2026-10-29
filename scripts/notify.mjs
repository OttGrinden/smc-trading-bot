#!/usr/bin/env node
/**
 * notify.mjs — Windows Toast Notifications für Trading-Alerts
 *
 * Nutzt die native Windows Runtime (WinRT) Toast API via PowerShell.
 * Kein externes Modul nötig — funktioniert auf Windows 10/11 out-of-the-box.
 *
 * Usage (CLI):
 *   node notify.mjs --title "Titel" --body "Nachricht" [--urgency high]
 *
 * Usage (module):
 *   import { sendToast, alertSlProximity, alertTakeProfit } from './notify.mjs'
 *   await sendToast({ title: 'AMAT', body: '0.4% vom Stop-Loss!', urgency: 'high' })
 */

import { spawnSync }    from 'child_process';
import { fileURLToPath } from 'url';

const APP_ID = 'TradingBot.Alerts';  // Windows App ID für Benachrichtigungen

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * sendToast — zeigt eine Windows-Toast-Notification.
 * Fail-soft: gibt { ok, error } zurück statt zu werfen.
 *
 * @param {{ title: string, body: string, urgency?: 'low'|'normal'|'high' }} opts
 */
export function sendToast({ title, body, urgency = 'normal' }) {
  // Sonderzeichen escapen — kein Injection-Risiko da nur single-quotes im PS-Script
  const safeTitle = String(title).replace(/'/g, "\\'").slice(0, 100);
  const safeBody  = String(body).replace(/'/g, "\\'").slice(0, 300);

  // WinRT Toast via PowerShell (keine externe Abhängigkeit)
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null

$template = @"
<toast>
  <visual>
    <binding template='ToastGeneric'>
      <text>${safeTitle}</text>
      <text>${safeBody}</text>
    </binding>
  </visual>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)
`.trim();

  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    timeout: 10_000,
    stdio:   ['ignore', 'pipe', 'pipe'],
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString('utf8')?.trim() ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ warn: 'notify_toast_failed', title, detail }) + '\n');
    return { ok: false, error: detail };
  }

  return { ok: true };
}

// ─── Typed alert helpers ──────────────────────────────────────────────────────

export function alertSlProximity({ symbol, side, distPct, pnlPct, markUsd }) {
  return sendToast({
    title:   `⚠ SL-Nähe: ${symbol} ${side.toUpperCase()}`,
    body:    `Nur ${distPct.toFixed(2)}% bis Stop-Loss (PnL ${pnlPct.toFixed(2)}% · $${markUsd?.toFixed(2) ?? '?'})`,
    urgency: 'high',
  });
}

export function alertTakeProfitHit({ symbol, side, pnlPct, tpPct }) {
  return sendToast({
    title:   `✅ Take-Profit: ${symbol} ${side.toUpperCase()}`,
    body:    `+${pnlPct.toFixed(2)}% Gewinn erreicht (TP-Ziel: +${tpPct}%)`,
    urgency: 'normal',
  });
}

export function alertBreakevenActivated({ symbol, side, peakPct, triggerPct }) {
  return sendToast({
    title:   `🔒 Breakeven aktiv: ${symbol} ${side.toUpperCase()}`,
    body:    `Peak +${peakPct.toFixed(2)}% erreicht (Trigger: +${triggerPct}%) — SL auf Einstieg gesetzt`,
    urgency: 'low',
  });
}

export function alertBreakevenHit({ symbol, side, pnlPct, peakPct, trailing }) {
  const label = trailing ? 'Trailing-Stop' : 'Breakeven-Stop';
  return sendToast({
    title:   `🔒 ${label}: ${symbol} ${side.toUpperCase()}`,
    body:    `PnL ${pnlPct.toFixed(2)}% · Peak war +${peakPct.toFixed(2)}% — Position geschlossen`,
    urgency: 'normal',
  });
}

export function alertScanComplete({ runId, longs, shorts, tvAvailable }) {
  return sendToast({
    title:   '📊 Scan abgeschlossen',
    body:    `${longs}L · ${shorts}S · TV ${tvAvailable} — ${runId}`,
    urgency: 'low',
  });
}

export function alertDirectionWatch({ symbol, side, daysOpen, reason }) {
  return sendToast({
    title:   `👁 Direction Watch: ${symbol} ${side.toUpperCase()}`,
    body:    `${daysOpen ?? '?'}d offen · ${reason ?? 'not_in_top_candidates'} — manuell prüfen`,
    urgency: 'normal',
  });
}

export function alertMarkFailed({ symbol, side }) {
  return sendToast({
    title:   `⚠ Mark fehlgeschlagen: ${symbol}`,
    body:    `${side.toUpperCase()}-Position kann nicht bewertet werden — Preis manuell prüfen`,
    urgency: 'high',
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const args  = process.argv.slice(2);
  const get   = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

  const title   = get('--title')   ?? 'TradingBot';
  const body    = get('--body')    ?? '';
  const urgency = get('--urgency') ?? 'normal';

  if (!body) {
    process.stderr.write('Usage: node notify.mjs --title "Titel" --body "Nachricht" [--urgency high]\n');
    process.exit(1);
  }

  const result = sendToast({ title, body, urgency });
  if (!result.ok) process.exit(1);
}
