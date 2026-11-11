// (d) Gate sign-in end to end (architecture.md "Signing in to an instance"; D15, D19, D44, D45).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, APP_ORIGIN, instanceOrigin } from './lib/config.mjs';
import {
  Person, expectStatus, getSuperadmin, instanceFetch, instanceFixture, inviteAndJoin, jwtPayload, signInToInstance, signUp,
} from './lib/flows.mjs';

const skip = await skipUnlessUp();

describe('gate sign-in', { skip }, () => {
  let fx;
  before(async () => {
    fx = await instanceFixture('g');
  });

  it('visit -> /authorize -> callback -> instance, with the right identity', async () => {
    const { member, inst, orgId, teamId } = fx;
    const { hops, echo } = await signInToInstance(member, inst.host, '/some/page?x=1');
    const [first, authorize, callback] = hops;

    assert.equal(first.status, 302);
    const toAuthorize = new URL(first.location);
    assert.equal(toAuthorize.origin, APP_ORIGIN);
    assert.equal(toAuthorize.pathname, '/authorize');
    assert.equal(toAuthorize.searchParams.get('host'), inst.host);
    assert.equal(toAuthorize.searchParams.get('return'), '/some/page?x=1');
    assert.ok(first.setCookies.some((c) => c.startsWith('__Host-gate-state=')), 'state cookie set');
    const stateCookie = first.setCookies.find((c) => c.startsWith('__Host-gate-state='));
    assert.match(stateCookie, /HttpOnly/i);
    assert.doesNotMatch(stateCookie, /Domain=/i, '__Host- cookies have no Domain');

    assert.equal(authorize.status, 302, authorize.describe());
    const toCallback = new URL(authorize.location);
    assert.equal(toCallback.origin, instanceOrigin(inst.host));
    assert.equal(toCallback.pathname, '/.gate/callback');
    assert.equal(toCallback.searchParams.get('state'), toAuthorize.searchParams.get('state'));
    assert.ok(toCallback.searchParams.get('code'));

    assert.equal(callback.status, 302, callback.describe());
    assert.equal(new URL(callback.location).pathname + new URL(callback.location).search, '/some/page?x=1');
    assert.ok(callback.setCookies.some((c) => c.startsWith('__Host-gate=')), 'gate session cookie set');

    assert.equal(echo.host, inst.host);
    assert.equal(echo.path, '/some/page');
    const id = echo.identity;
    assert.equal(id.iss, APP_ORIGIN);
    assert.equal(id.aud, inst.host);
    assert.equal(id.sub, member.id);
    assert.equal(id.email, member.email);
    assert.equal(id.org, orgId);
    assert.equal(id.inst, inst.id);
    assert.deepEqual(id.teams, [teamId]);
    assert.ok(id.exp - id.iat <= 600, 'short-lived token');
    assert.equal(echo.cookies['__Host-gate'], undefined, 'the gate never forwards its own cookie');
    assert.equal(echo.headers['x-forwarded-host'], inst.host);
  });

  it('the callback code is single-use and bound to its host', async () => {
    const { member, inst } = fx;
    const p = new Person(member.email, 'replay');
    expectStatus(await p.signInWithCode(), 200);
    const first = await p.browser.fetch(`${instanceOrigin(inst.host)}/`, { navigate: true });
    const authorize = await p.browser.fetch(first.location, { navigate: true });
    const callbackUrl = authorize.location;
    const cb = await p.browser.fetch(callbackUrl, { navigate: true });
    assert.equal(cb.status, 302);
    // Replaying the same callback (state cookie now cleared, code used) fails.
    const replay = await p.browser.fetch(callbackUrl, { navigate: true });
    assert.equal(replay.status, 400, replay.describe());

    // A fresh code for the instance host, presented on the key page host with a valid state there.
    const q = new Person(member.email, 'cross-host');
    expectStatus(await q.signInWithCode(), 200);
    const a1 = await q.browser.fetch(`${instanceOrigin(inst.host)}/`, { navigate: true });
    const a2 = await q.browser.fetch(a1.location, { navigate: true });
    const code = new URL(a2.location).searchParams.get('code');
    const k1 = await q.browser.fetch(`${instanceOrigin(inst.keyHost)}/`, { navigate: true });
    const kState = new URL(k1.location).searchParams.get('state');
    const planted = await q.browser.fetch(`${instanceOrigin(inst.keyHost)}/.gate/callback?code=${encodeURIComponent(code)}&state=${kState}&return=/`, { navigate: true });
    assert.equal(planted.status, 400, `a code for ${inst.host} must not work on ${inst.keyHost}: ${planted.describe()}`);
    // And it was burned: no longer usable on its own host either.
    const original = await q.browser.fetch(a2.location, { navigate: true });
    assert.equal(original.status, 400, original.describe());
  });

  it('a callback with the wrong state is refused', async () => {
    const { member, inst } = fx;
    const p = new Person(member.email, 'wrong-state');
    expectStatus(await p.signInWithCode(), 200);
    const first = await p.browser.fetch(`${instanceOrigin(inst.host)}/`, { navigate: true });
    const authorize = await p.browser.fetch(first.location, { navigate: true });
    const u = new URL(authorize.location);
    u.searchParams.set('state', 'X'.repeat(32));
    const res = await p.browser.fetch(u.toString(), { navigate: true });
    assert.equal(res.status, 400, res.describe());
  });

  it('without a control-plane session: sign in first, then back to the instance', async () => {
    const { member, inst } = fx;
    const p = new Person(member.email, 'fresh-browser');
    const { hops, final } = await p.browser.navigate(`${instanceOrigin(inst.host)}/after-login`);
    assert.equal(final.status, 200, `sign-in page: ${final.describe()}`);
    const signIn = new URL(hops.at(-1).url);
    assert.equal(signIn.pathname, '/sign-in');
    const next = signIn.searchParams.get('next');
    assert.ok(next?.startsWith('/authorize?'), `next points back to /authorize: ${next}`);
    expectStatus(await p.signInWithCode(), 200);
    const back = await p.browser.navigate(`${APP_ORIGIN}${next}`);
    assert.equal(back.final.status, 200, back.final.describe());
    assert.equal(back.final.json().path, '/after-login');
  });

  it('the key page host gets its own token audience (D9)', async () => {
    const { member, inst } = fx;
    const { echo } = await signInToInstance(member, inst.keyHost);
    assert.equal(echo.host, inst.keyHost);
    assert.equal(echo.identity.aud, inst.keyHost);
    assert.equal(jwtPayload(echo.headers['x-worca-identity']).aud, inst.keyHost);
  });

  it('org members outside the granting team, outsiders and platform staff are refused (D15, D19)', async () => {
    const { admin, orgId, inst } = fx;
    const noTeam = await inviteAndJoin(admin, orgId, 'g-noteam');
    const outsider = await signUp('g-outsider');
    const sa = await getSuperadmin();
    for (const [who, p] of [['member without team', noTeam], ['outsider', outsider], ['superadmin', sa]]) {
      const { final } = await p.browser.navigate(`${instanceOrigin(inst.host)}/`);
      assert.ok([403, 404].includes(final.status), `${who}: ${final.describe()}`);
      assert.equal(new URL(final.url).origin, APP_ORIGIN, `${who} stays on the control plane`);
      const api = await instanceFetch(p, inst.host, '/api/x');
      assert.equal(api.status, 401, `${who} API call: ${api.describe()}`);
    }
    // A tenant admin is not automatically let in either: access is through teams only (D19).
    const { final } = await admin.browser.navigate(`${instanceOrigin(inst.host)}/`);
    assert.equal(final.status, 403, `tenant admin without a team: ${final.describe()}`);
  });

  it('non-navigation requests without a session get 401, not a redirect (W6)', async () => {
    const p = new Person('nobody@e2e.test', 'api-client');
    const res = await instanceFetch(p, fx.inst.host, '/api/state');
    assert.equal(res.status, 401, res.describe());
    assert.equal(res.json().error, 'signin_required');
  });

  it('signing out of the gate drops the session', async () => {
    const { member, inst } = fx;
    const p = new Person(member.email, 'gate-signout');
    expectStatus(await p.signInWithCode(), 200);
    await signInToInstance(p, inst.host);
    const out = await p.browser.fetch(`${instanceOrigin(inst.host)}/.gate/signout`, { navigate: true });
    assert.ok([200, 204, 302].includes(out.status), out.describe());
    const after = await instanceFetch(p, inst.host, '/x', { method: 'POST', body: {} });
    assert.equal(after.status, 401, after.describe());
  });
});
