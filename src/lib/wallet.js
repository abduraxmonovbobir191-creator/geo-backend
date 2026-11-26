// The Nex ID wallet (Stars), the one place money lives. Nex Map never holds or sells Stars:
// people buy Stars in the App Store / Google Play (or at Nex ID on the web) (`walletUrl`), Nex Map asks Nex ID (server to server, confidential client) to charge.
// Every call has a `ref`, so a retry never takes money twice. Errors keep Nex ID's codes (insufficient_funds -> 402).
import { config } from '../config.js';
import { HttpError } from './http.js';
import { nexidEnabled, transport } from './nexid.js';

export const walletUrl = () => `${config.nexid.issuer}/account/wallet`;

async function call(path, body) {
  if (!nexidEnabled()) throw new HttpError(503, 'wallet_unavailable', 'The Nex ID wallet is not available');
  const enc = encodeURIComponent;
  let res;
  try {
    res = await transport.call(`${config.nexid.issuer}${path}`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${enc(config.nexid.clientId)}:${enc(config.nexid.clientSecret)}`).toString('base64'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(503, 'wallet_unavailable', 'The Nex ID wallet is not available');
  }
  if (res.status >= 400) {
    const code = String(res.data?.error || res.data?.detail || 'wallet_unavailable');
    if (code === 'insufficient_funds') throw new HttpError(402, 'insufficient_funds', 'Not enough Stars', { walletUrl: walletUrl() });
    if (res.status < 500 && [403, 404, 409, 422].includes(res.status)) throw new HttpError(res.status, code, 'The wallet refused this');
    throw new HttpError(503, 'wallet_unavailable', 'The Nex ID wallet is not available');
  }
  return res.data;
}

export async function balance(sub) {
  const d = await call('/api/partner/wallet/balance', { sub });
  return { balance: Number(d.balance) || 0, walletUrl: walletUrl() };
}
export const charge = (sub, amount, ref, memo) => call('/api/partner/wallet/charge', { sub, amount, ref: ref.slice(0, 100), memo: memo.slice(0, 200) });
export const refund = (ref) => call('/api/partner/wallet/refund', { ref: ref.slice(0, 100) });
