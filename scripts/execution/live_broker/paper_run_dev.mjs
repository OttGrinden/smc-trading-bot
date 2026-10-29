/**
 * paper_run_dev — controlled DEV/TEST entrypoint for ONE paper run cycle (Phase 1, Unit 8).
 *
 * This is a deliberate, manual dev/test tool — NOT a productized runtime entry. It
 * does NOT wire into scan.mjs, the engine, a scheduler, a daemon, or any loop. It runs
 * exactly ONE lease-protected reconcile→poll cycle and then exits.
 *
 *   parseBrokerExecConfig(argv, env)   → fail-closed alpaca_paper guard (throws if invalid)
 *   brokerExecEnabled(execConfig)      → reject anything not an enabled paper config
 *   new AlpacaPaperBroker(execConfig)  → construct the paper adapter (no network on construct)
 *   runPaperCycleOnce({ broker, execConfig })  → exactly one cycle
 *   → print a small machine-readable summary, exit with a clear code
 *
 * It adds NO trading logic: no submit of new orders, no recovery-submit, no
 * cancel/replace, no portfolio/cash/PnL mutation. All dependencies (broker, runner,
 * makeBroker) are injectable so the entrypoint is fully offline-testable.
 *
 * Exit codes (CLI): ran → 0 ; did-not-run (lease blocked / worker_error) → 1 ;
 * config/guard/fatal error → 2.
 */

import { fileURLToPath } from 'url';

import { parseBrokerExecConfig, brokerExecEnabled } from './live_broker_config.mjs';
import { AlpacaPaperBroker }                        from './adapters/alpaca_paper_broker.mjs';
import { runPaperCycleOnce }                        from './paper_runner.mjs';

/**
 * runDevPaperCycle — load+guard config, obtain a paper broker, run ONE cycle.
 *
 * @param {object} o
 * @param {string[]} [o.argv]      — CLI args (e.g. process.argv.slice(2))
 * @param {object}   [o.env]       — environment (e.g. process.env)
 * @param {object}   [o.broker]    — injected broker (tests); else makeBroker(execConfig)
 * @param {Function} [o.runner]    — injected cycle runner (tests); else runPaperCycleOnce
 * @param {Function} [o.makeBroker]— broker factory; default new AlpacaPaperBroker(cfg)
 * @param {object}   [o.leaseOpts] — forwarded to the runner's lease acquisition
 * @returns {Promise<object>} the runner summary
 * @throws  {Error} fail-closed on invalid / non-paper / disabled config (before any run)
 */
export async function runDevPaperCycle({
  argv = [], env = {}, broker = null,
  runner = runPaperCycleOnce,
  makeBroker = (cfg) => new AlpacaPaperBroker(cfg),
  leaseOpts,
} = {}) {
  // 1) Fail-closed config guard FIRST (throws on live URL / ALPACA_PAPER=false / missing creds / bad mode).
  const execConfig = parseBrokerExecConfig(argv, env);
  if (!brokerExecEnabled(execConfig)) {
    throw new Error('paper_run_dev: requires an enabled alpaca_paper config (set --broker-exec alpaca_paper / BROKER_EXEC) — fail-closed, no run');
  }

  // 2) Obtain the paper broker (injected for tests, else constructed from the guarded config).
  const paperBroker = broker ?? makeBroker(execConfig);

  // 3) Exactly ONE cycle. No loop, no repeat.
  return runner({ broker: paperBroker, execConfig, leaseOpts });
}

/** devExitCode — map a runner summary to a CLI exit code (ran → 0, otherwise → 1). */
export function devExitCode(summary) {
  return summary && summary.ran === true ? 0 : 1;
}

// ─── CLI (dev/test only) — single explicit invocation, never auto-runs on import ──
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runDevPaperCycle({ argv: process.argv.slice(2), env: process.env })
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(devExitCode(summary));
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ ran: false, reason: 'fatal', error: err?.message ?? String(err) }, null, 2) + '\n');
      process.exit(2);   // config / guard / fatal error
    });
}
