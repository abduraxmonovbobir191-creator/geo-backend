import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_KEYS = 'nexly:nexly-key,nexgramm:gram-key';
const { app, pool, request, resetDatabase } = await import('./helpers.js');

describe('Nexly single sign-on', () => {
  before(resetDatabase);
  after(() => pool.end());

  it('opens a Nex Map session for a person Nexly signed in, only for allowed services', async () => {
    const svc = { 'X-Service-Key': 'nexly-key' };
    const res = await request(app).post('/internal/v1/session').set(svc)
      .send({ sub: 'sub-sso', name: 'Sso User', username: 'sso_user', verificationLevel: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const me = await request(app).get('/v1/me').set('Authorization', `Bearer ${res.body.token}`);
    assert.equal(me.body.username, 'sso_user');
    assert.equal(me.body.nexid.verificationLevel, 1);
    const again = await request(app).post('/internal/v1/session').set(svc).send({ sub: 'sub-sso' });
    assert.equal(again.body.userId, res.body.userId);
    // Nexgram may use the service API but not open sessions; a user token is not a service key.
    assert.equal((await request(app).post('/internal/v1/session').set({ 'X-Service-Key': 'gram-key' }).send({ sub: 'x' })).status, 403);
    assert.equal((await request(app).post('/internal/v1/session').set({ 'X-Service-Key': res.body.token }).send({ sub: 'x' })).status, 401);
  });
});
