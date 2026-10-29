/**
 * paths.mjs — Central path configuration
 * All paths are computed relative to this file's location (scripts/),
 * so the repo works regardless of where it is cloned.
 */
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(__filename);
export const BASE_DIR      = resolve(SCRIPTS_DIR, '..');
export const TRADING_DIR   = join(BASE_DIR, 'trading');
export const CACHE_DIR     = join(TRADING_DIR, 'cache');
export const LOGS_DIR      = join(TRADING_DIR, 'logs');
export const REGISTRY_DIR  = join(TRADING_DIR, 'registry');
export const EXECUTION_DIR = join(TRADING_DIR, 'execution');
export const PORTFOLIO_DIR = join(EXECUTION_DIR, 'portfolio');
export const ORDERS_DIR    = join(EXECUTION_DIR, 'orders');
export const AUDIT_DIR     = join(EXECUTION_DIR, 'audit');
export const LIVE_ORDERS_DIR = join(EXECUTION_DIR, 'live_orders');
export const DECISIONS_DIR = join(EXECUTION_DIR, 'decisions');
export const LIVE_BROKER_DIR = join(EXECUTION_DIR, 'live_broker');
