// (a) Sign-in and registration modes (D22, D24, D25, identity-and-access.md "Registration").
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, APP_ORIGIN, instanceOrigin, readDevVars } from './lib/config.mjs';
import { request } from './lib/http.mjs';
import {
  API, Person, createRegistrationCode, expectStatus, getSuperadmin, uniqueEmail, withRegistrationMode,
} from './lib/flows.mjs';

const skip = await skipUnlessUp();

describe('auth and registration', { skip }, () => {
  before(async () => {
    await getSuperadmin();
  });

  it('first-superadmin setup is one-time and needs the setup token', async () => {
    const wrong = await request(`${API}/setup`, { method: 'POST', body: { token: 'nope', email: uniqueEmail('setup') } });
    assert.equal(wrong.status, 403, wrong.describe());
    const again = await request(`${API}/setup`, { method: 'POST', body: { token: readDevVars().SETUP_TOKEN, email: uniqueEmail('setup') } });
    assert.equal(again.status, 409, again.describe());
  });

  it('unauthenticated API calls get 401, page loads a redirect to sign-in', async () => {
    const p = new Person(uniqueEmail('anon'));
    assert.equal((await p.get('/api/me')).status, 401);
    const page = await p.browser.fetch(`${APP_ORIGIN}/authorize?host=x.run.localhost&state=${'s'.repeat(20)}`, { navigate: true });
    assert.equal(page.status, 302, page.describe());
    assert.match(page.location, /\/sign-in\?/);
  });

  describe('invite-code mode', () => {
    it('refuses a new account without a code, and with an unknown code', async () => {
      await withRegistrationMode('invite_code', async () => {
        const p = new Person(uniqueEmail('nocode'));
        const res = await p.signInWithCode();
        assert.equal(res.status, 403, res.describe());
        assert.match(res.text, /signup_code_required|code is required/i);
        const bad = await p.signInWithCode({ signupCode: 'NOT-A-REAL-CODE' });
        assert.equal(bad.status, 403, bad.describe());
        assert.equal((await p.me()), null, 'no session');
      });
    });

    it('accepts a valid code once, giving an active account', async () => {
      await withRegistrationMode('invite_code', async () => {
        const code = await createRegistrationCode({ uses: 1 });
        const p = new Person(uniqueEmail('withcode'));
        expectStatus(await p.signInWithCode({ signupCode: code }), 200, 'sign-up with code');
        const me = await p.me();
        assert.equal(me.user.status, 'active');
        assert.equal(me.session.method, 'email-otp');
        assert.equal(me.session.mfa, false, 'an email code is not MFA');
        const q = new Person(uniqueEmail('reuse'));
        const reused = await q.signInWithCode({ signupCode: code });
        assert.equal(reused.status, 403, `a single-use code must not work twice: ${reused.describe()}`);
      });
    });

    it('lets an existing account sign in without a code', async () => {
      const code = await createRegistrationCode();
      const p = new Person(uniqueEmail('returning'));
      expectStatus(await p.signInWithCode({ signupCode: code }), 200);
      await p.signOut();
      assert.equal(await p.me(), null, 'signed out');
      expectStatus(await p.signInWithCode(), 200, 'second sign-in without code');
    });
  });

  describe('waitlist mode', () => {
    it('creates a pending account that can do nothing until approved', async () => {
      const sa = await getSuperadmin();
      await withRegistrationMode('waitlist', async () => {
        const p = new Person(uniqueEmail('waiting'));
        expectStatus(await p.signInWithCode(), 200, 'waitlist sign-up');
        const me = await p.me();
        assert.equal(me.user.status, 'pending');
        const org = await p.post('/api/orgs', { name: 'Should fail' });
        assert.equal(org.status, 403, org.describe());
        const list = expectStatus(await sa.get('/api/platform/waitlist'), 200).json();
        assert.ok(list.pending.some((u) => u.id === me.user.id), 'listed on the waitlist');
        expectStatus(await sa.post(`/api/platform/waitlist/${me.user.id}/approve`), 200, 'approve');
        assert.equal((await p.me()).user.status, 'active');
      });
    });
  });

  describe('open mode', () => {
    it('gives anyone with a verified email an active account', async () => {
      await withRegistrationMode('open', async () => {
        const p = new Person(uniqueEmail('open'));
        expectStatus(await p.signInWithCode(), 200);
        assert.equal((await p.me()).user.status, 'active');
      });
    });
  });

  describe('passkeys and MFA', () => {
    it('registers a passkey and signs in with it as MFA (D24)', async () => {
      const code = await createRegistrationCode();
      const p = new Person(uniqueEmail('passkey'));
      expectStatus(await p.signInWithCode({ signupCode: code }), 200);
      await p.upgradeToPasskey();
      const me = await p.me();
      assert.equal(me.session.method, 'passkey');
      assert.equal(me.session.mfa, true);
      // A brand-new browser with the same authenticator signs in by passkey alone.
      const other = new Person(p.email, 'second-device');
      other.authenticator = p.authenticator;
      await other.signInWithPasskey();
      assert.equal((await other.me()).user.id, me.user.id);
    });

    it('platform capabilities need an MFA session even for a superadmin', async () => {
      const sa = await getSuperadmin();
      const codeOnly = new Person(sa.email, 'superadmin-code-only');
      expectStatus(await codeOnly.signInWithCode(), 200);
      const res = await codeOnly.get('/api/platform/registration');
      assert.equal(res.status, 403, res.describe());
      assert.match(res.text, /mfa_required/);
      expectStatus(await sa.get('/api/platform/registration'), 200, 'with passkey session');
    });

    it('non-staff get 403 on the platform API', async () => {
      const code = await createRegistrationCode();
      const p = new Person(uniqueEmail('nostaff'));
      expectStatus(await p.signInWithCode({ signupCode: code }), 200);
      await p.upgradeToPasskey();
      assert.equal((await p.get('/api/platform/orgs')).status, 403);
    });
  });

  it('refuses state-changing requests from another origin', async () => {
    const code = await createRegistrationCode();
    const p = new Person(uniqueEmail('origin'));
    expectStatus(await p.signInWithCode({ signupCode: code }), 200);
    const evil = await p.browser.fetch(`${APP_ORIGIN}/api/orgs`, { method: 'POST', body: { name: 'x' }, from: 'https://evil.example' });
    assert.equal(evil.status, 403, evil.describe());
    const fromInstance = await p.browser.fetch(`${APP_ORIGIN}/api/orgs`, { method: 'POST', body: { name: 'x' }, from: instanceOrigin('abc.run.localhost') });
    assert.notEqual(fromInstance.status, 201, `an instance page must not create orgs: ${fromInstance.describe()}`);
  });
});
