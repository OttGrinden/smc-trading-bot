import crypto from 'node:crypto';
import https from 'node:https';

const apiKey    = process.env.BITUNIX_API_KEY;
const secretKey = process.env.BITUNIX_SECRET_KEY;
const baseUrl   = 'fapi.bitunix.com';

if (!apiKey || !secretKey) {
  console.error('BITUNIX_API_KEY / BITUNIX_SECRET_KEY not set');
  process.exit(1);
}

function makeNonce()   { return crypto.randomBytes(16).toString('hex'); }
function signParams(p) { return Object.keys(p).sort().map(k => k + p[k]).join(''); }
function urlParams(p)  { return Object.keys(p).sort().map(k => k + '=' + encodeURIComponent(p[k])).join('&'); }

function authHeaders(params, body = '') {
  const timestamp = Date.now().toString();
  const nonce     = makeNonce();
  const digest    = crypto.createHash('sha256').update(nonce + timestamp + apiKey + signParams(params) + body).digest('hex');
  const signature = crypto.createHash('sha256').update(digest + secretKey).digest('hex');
  return { 'api-key': apiKey, sign: signature, timestamp, nonce };
}

function get(path, params = {}) {
  return new Promise((resolve, reject) => {
    const query   = Object.keys(params).length ? '?' + urlParams(params) : '';
    const headers = { ...authHeaders(params), Accept: 'application/json' };
    const req = https.request({ hostname: baseUrl, port: 443, path: path + query, method: 'GET', headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, body: raw }); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Try transaction/order history endpoints
const endpoints = [
  { path: '/api/v1/futures/position/get_history_positions',   params: { marginCoin: 'USDT', pageSize: '100' } },
  { path: '/api/v1/futures/trade/get_history_orders',         params: { marginCoin: 'USDT', pageSize: '100' } },
  { path: '/api/v1/futures/trade/history_orders',             params: { marginCoin: 'USDT', pageSize: '100' } },
  { path: '/api/v1/futures/order/list_history',               params: { marginCoin: 'USDT', pageSize: '100' } },
  { path: '/api/v1/futures/trade/get_fill_orders',            params: { marginCoin: 'USDT', pageSize: '100' } },
  { path: '/api/v1/futures/account/bill',                     params: { marginCoin: 'USDT', pageSize: '100' } },
  { path: '/api/v1/futures/account/transaction_records',      params: { marginCoin: 'USDT', pageSize: '100' } },
];

console.error('Probing Bitunix endpoints for trade history...');
let found = null;
for (const ep of endpoints) {
  process.stderr.write(`  GET ${ep.path} ... `);
  const r = await get(ep.path, ep.params);
  process.stderr.write(`${r.status}\n`);
  if (r.status === 200 && r.body?.code === 0) {
    console.error(`  -> SUCCESS: ${ep.path}`);
    found = { endpoint: ep.path, response: r.body };
    break;
  }
  if (r.status === 200 && r.body?.code != null && r.body.code !== 0) {
    console.error(`  -> API error code ${r.body.code}: ${r.body.msg}`);
  }
}

if (!found) {
  console.error('No working endpoint found. Dumping last response for diagnosis:');
  const last = await get(endpoints[0].path, endpoints[0].params);
  console.log(JSON.stringify(last, null, 2));
  process.exit(1);
}

// Extract trades and filter positive PnL
const data = found.response?.data;
const trades = Array.isArray(data) ? data
  : Array.isArray(data?.list) ? data.list
  : Array.isArray(data?.orders) ? data.orders
  : [];

console.error(`Total records from ${found.endpoint}: ${trades.length}`);
console.log(JSON.stringify({ endpoint: found.endpoint, raw_sample: trades.slice(0, 2) }, null, 2));
