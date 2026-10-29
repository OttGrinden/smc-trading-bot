import crypto from 'node:crypto';
import https from 'node:https';

const apiKey    = process.env.BITUNIX_API_KEY;
const secretKey = process.env.BITUNIX_SECRET_KEY;
const baseUrl   = 'fapi.bitunix.com';

function makeNonce()      { return crypto.randomBytes(16).toString('hex'); }
function signParams(p)    { return Object.keys(p).sort().map(k => k + p[k]).join(''); }
function urlParams(p)     { return Object.keys(p).sort().map(k => k + '=' + encodeURIComponent(p[k])).join('&'); }

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
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.end();
  });
}

const pos = await get('/api/v1/futures/position/get_pending_positions', { marginCoin: 'USDT' });
console.log(JSON.stringify(pos, null, 2));
