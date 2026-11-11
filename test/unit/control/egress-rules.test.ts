// Outbound network policy (D73), the pure rules: entries, policies, the effective policy, what
// counts as loosening, and the variables worca gets.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import {
  effectivePolicy,
  egressVariables,
  EMPTY_DENY,
  entryMatches,
  isHostAllowed,
  isLoosening,
  MAX_EGRESS_ENTRIES,
  normalizeEntry,
  normalizeList,
  normalizePolicy,
  platformEgressHosts,
  samePolicy,
  worcaEntry,
  type EgressPolicy,
  type PlatformHost,
} from '../../../packages/platform/src/control/instances/egress';

const PROD = { APP_ORIGIN: 'https://app.worca.dev', COMPUTE_PROVIDER: 'railway', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env;
const platform: PlatformHost[] = platformEgressHosts(PROD);

const open = (): EgressPolicy => ({ mode: 'open', allow: [], deny: [] });
const block = (...deny: string[]): EgressPolicy => ({ mode: 'block', allow: [], deny });
const allow = (allowList: string[], deny: string[] = []): EgressPolicy => ({ mode: 'allow', allow: allowList, deny });

describe('platform hosts', () => {
  it('the control plane and the private broker, nothing for cloudflared or the broker', () => {
    expect(platform.map((p) => p.host)).toEqual(['app.worca.dev', 'worca-run-broker.railway.internal']);
    for (const p of platform) expect(p.why).toBeTruthy();
  });
  it('local development adds the heartbeat address the stub uses', () => {
    const local = platformEgressHosts({ APP_ORIGIN: 'http://app.localhost:8787', LOCAL_DEV: '1', COMPUTE_PROVIDER: 'fake', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env);
    expect(local.map((p) => p.host)).toEqual(['app.localhost', '127.0.0.1', 'worca-run-broker.railway.internal']);
  });
});

describe('normalizeEntry', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM  ', 'example.com'],
    ['example.com.', 'example.com'],
    ['*.example.com', '*.example.com'],
    ['*.Sub.Example.com.', '*.sub.example.com'],
    ['a-b.c-d.io', 'a-b.c-d.io'],
    ['xn--bcher-kva.de', 'xn--bcher-kva.de'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['*.BÜCHER.de', '*.xn--bcher-kva.de'],
    ['münchen.example.com', 'xn--mnchen-3ya.example.com'],
    ['1password.com', '1password.com'],
    [`${'a'.repeat(63)}.com`, `${'a'.repeat(63)}.com`],
  ])('%s → %s', (raw, entry) => {
    expect(normalizeEntry(raw)).toEqual({ entry });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['https://example.com', 'scheme'],
    ['ftp://example.com', 'scheme'],
    ['example.com/path', 'path'],
    ['example.com:443', 'port'],
    ['[::1]', 'ip'],
    ['2001:db8::1', 'ip'],
    ['10.0.0.1', 'ip'],
    ['192.168.1.1', 'ip'],
    ['example.123', 'ip'],
    ['*', 'wildcard'],
    ['*example.com', 'wildcard'],
    ['ex*ample.com', 'wildcard'],
    ['example.*', 'wildcard'],
    ['*.*.example.com', 'wildcard'],
    ['a.*.example.com', 'wildcard'],
    ['**.example.com', 'wildcard'],
    ['localhost', 'no_dot'],
    ['com', 'no_dot'],
    ['*.com', 'no_dot'],
    ['*.', 'wildcard'],
    ['a..b.com', 'label'],
    ['.example.com', 'label'],
    ['-bad.example.com', 'label'],
    ['bad-.example.com', 'label'],
    [`${'a'.repeat(64)}.com`, 'length'],
    [`${'a.'.repeat(127)}com`, 'length'],
    ['under_score.com', 'chars'],
    ['spa ce.com', 'chars'],
    ['user@example.com', 'chars'],
    ['exa$mple.com', 'chars'],
  ])('%j is refused (%s)', (raw, problem) => {
    expect(normalizeEntry(raw)).toEqual({ problem });
  });
});

describe('normalizeList', () => {
  it('normalizes, skips blanks, drops duplicates keeping the first', () => {
    expect(normalizeList(['GitHub.com', '', ' github.com ', '*.npmjs.org', '*.NPMJS.org.', '  '], 'allow')).toEqual({ list: ['github.com', '*.npmjs.org'] });
  });
  it('names the first bad entry, its list and why', () => {
    expect(normalizeList(['ok.com', 'https://bad.com', 'also bad'], 'deny')).toEqual({
      problem: { code: 'egress_host_invalid', field: 'deny', entry: 'https://bad.com', reason: 'scheme' },
    });
  });
  it(`at most ${MAX_EGRESS_ENTRIES} entries, counted after duplicates are dropped`, () => {
    const many = Array.from({ length: MAX_EGRESS_ENTRIES }, (_, i) => `h${i}.example.com`);
    expect(normalizeList([...many, ...many], 'allow')).toMatchObject({ list: many });
    expect(normalizeList([...many, 'one-more.example.com'], 'allow')).toEqual({ problem: { code: 'egress_too_many', field: 'allow' } });
  });
});

describe('normalizePolicy', () => {
  it('keeps only the lists the mode uses', () => {
    expect(normalizePolicy({ mode: 'open', allow: ['a.com'], deny: ['b.com', 'not valid'] }, platform)).toEqual({ policy: open() });
    expect(normalizePolicy({ mode: 'block', allow: ['bad entry'], deny: ['B.com'] }, platform)).toEqual({ policy: block('b.com') });
    expect(normalizePolicy({ mode: 'allow', allow: ['a.com'], deny: ['x.a.com'] }, platform)).toEqual({ policy: allow(['a.com'], ['x.a.com']) });
    expect(normalizePolicy({ mode: 'allow' }, platform)).toEqual({ policy: allow([]) });
  });
  it('refuses a block entry that would block one of the platform hosts, exactly or by a wildcard', () => {
    for (const bad of ['app.worca.dev', '*.worca.dev', '*.railway.internal', 'worca-run-broker.railway.internal']) {
      expect(normalizePolicy({ mode: 'block', deny: ['fine.com', bad] }, platform)).toEqual({
        problem: { code: 'egress_blocks_platform_host', field: 'deny', entry: bad },
      });
      expect(normalizePolicy({ mode: 'allow', allow: ['x.com'], deny: [bad] }, platform)).toMatchObject({ problem: { code: 'egress_blocks_platform_host' } });
    }
    // The apex isn't matched by a wildcard, and other hosts of the domain are fine.
    expect(normalizePolicy({ mode: 'block', deny: ['worca.dev', 'www.worca.dev', '*.app.worca.dev'] }, platform)).toMatchObject({ policy: { mode: 'block' } });
  });
  it('allowing a platform host is fine (it always is)', () => {
    expect(normalizePolicy({ mode: 'allow', allow: ['app.worca.dev'] }, platform)).toEqual({ policy: allow(['app.worca.dev']) });
  });
});

describe('matching and the effective policy', () => {
  it('an exact entry matches only itself; a wildcard every subdomain, not the apex', () => {
    expect(entryMatches('example.com', 'example.com')).toBe(true);
    expect(entryMatches('example.com', 'www.example.com')).toBe(false);
    expect(entryMatches('*.example.com', 'www.example.com')).toBe(true);
    expect(entryMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(entryMatches('*.example.com', 'example.com')).toBe(false);
    expect(entryMatches('*.example.com', 'badexample.com')).toBe(false);
  });
  it('block wins over allow; platform hosts always pass', () => {
    const p = allow(['*.github.com'], ['gist.github.com']);
    expect(isHostAllowed(p, 'api.github.com', platform)).toBe(true);
    expect(isHostAllowed(p, 'gist.github.com', platform)).toBe(false);
    expect(isHostAllowed(p, 'github.com', platform)).toBe(false);
    expect(isHostAllowed(p, 'app.worca.dev', platform)).toBe(true);
    expect(isHostAllowed(block('*.example.com'), 'a.example.com')).toBe(false);
    expect(isHostAllowed(block('*.example.com'), 'example.com')).toBe(true);
    expect(isHostAllowed(open(), 'anything.example')).toBe(true);
  });
  it('the override, else the org', () => {
    const org = block('x.com');
    expect(effectivePolicy(org, null)).toBe(org);
    const own = allow(['a.com']);
    expect(effectivePolicy(org, own)).toBe(own);
  });
  it('samePolicy ignores the order of entries; null is no override', () => {
    expect(samePolicy(allow(['a.com', 'b.com']), allow(['b.com', 'a.com']))).toBe(true);
    expect(samePolicy(allow(['a.com']), block('a.com'))).toBe(false);
    expect(samePolicy(null, null)).toBe(true);
    expect(samePolicy(null, open())).toBe(false);
  });
});

describe('isLoosening', () => {
  // [description, from, to, loosening]
  const cases: [string, EgressPolicy, EgressPolicy, boolean][] = [
    // from open: nothing to loosen
    ['open → open', open(), open(), false],
    ['open → block', open(), block('a.com'), false],
    ['open → allow', open(), allow(['a.com']), false],
    // to open
    ['block → open', block('a.com'), open(), true],
    ['block (empty) → open: blocked nothing before', block(), open(), false],
    ['allow → open', allow(['a.com']), open(), true],
    ['allow (empty) → open', allow([]), open(), true],
    // block → block
    ['block: same list', block('a.com', 'b.com'), block('b.com', 'a.com'), false],
    ['block: entry added', block('a.com'), block('a.com', 'b.com'), false],
    ['block: entry removed', block('a.com', 'b.com'), block('a.com'), true],
    ['block: exact replaced by a wildcard covering it', block('x.a.com'), block('*.a.com'), false],
    ['block: wildcard replaced by exact', block('*.a.com'), block('x.a.com'), true],
    ['block: wildcard narrowed to a sub-wildcard', block('*.a.com'), block('*.x.a.com'), true],
    ['block: wildcard widened', block('*.x.a.com'), block('*.a.com'), false],
    ['block: wildcard for the apex is not the apex', block('a.com'), block('*.a.com'), true],
    ['block: exact replaced by another', block('a.com'), block('b.com'), true],
    // block → allow
    ['block → allow, allowing nothing blocked', block('bad.com'), allow(['good.com']), false],
    ['block → allow, allowing a blocked host', block('bad.com'), allow(['bad.com']), true],
    ['block → allow, allowing a blocked host and blocking it again', block('bad.com'), allow(['bad.com'], ['bad.com']), false],
    ['block → allow, wildcard over a blocked host', block('x.bad.com'), allow(['*.bad.com']), true],
    ['block → allow, wildcard over a blocked host, blocked again', block('x.bad.com'), allow(['*.bad.com'], ['x.bad.com']), false],
    ['block → allow, wildcard over a blocked wildcard, blocked again by a wider one', block('*.x.bad.com'), allow(['*.bad.com'], ['*.bad.com']), false],
    ['block → allow, allowed host under a blocked wildcard', block('*.bad.com'), allow(['api.bad.com']), true],
    ['block (empty) → allow', block(), allow(['a.com']), false],
    // allow → block
    ['allow → block', allow(['a.com']), block('b.com'), true],
    ['allow → block (empty)', allow(['a.com']), block(), true],
    // allow → allow
    ['allow: same', allow(['a.com', '*.b.com'], ['x.b.com']), allow(['*.b.com', 'a.com'], ['x.b.com']), false],
    ['allow: allow entry added', allow(['a.com']), allow(['a.com', 'b.com']), true],
    ['allow: allow entry removed', allow(['a.com', 'b.com']), allow(['a.com']), false],
    ['allow: exact widened to a wildcard', allow(['x.a.com']), allow(['*.a.com']), true],
    ['allow: wildcard narrowed to exact', allow(['*.a.com']), allow(['x.a.com']), false],
    ['allow: apex added next to its wildcard', allow(['*.a.com']), allow(['*.a.com', 'a.com']), true],
    ['allow: block entry added', allow(['*.a.com']), allow(['*.a.com'], ['x.a.com']), false],
    ['allow: block entry removed', allow(['*.a.com'], ['x.a.com']), allow(['*.a.com']), true],
    ['allow: block entry narrowed', allow(['*.a.com'], ['*.x.a.com']), allow(['*.a.com'], ['y.x.a.com']), true],
    ['allow: block entry widened', allow(['*.a.com'], ['y.x.a.com']), allow(['*.a.com'], ['*.x.a.com']), false],
    ['allow: block entry removed that blocked nothing allowed', allow(['a.com'], ['z.com']), allow(['a.com']), false],
    ['allow: new allow entry, fully blocked', allow(['a.com']), allow(['a.com', 'b.com'], ['b.com']), false],
    ['allow: new wildcard, partly blocked', allow(['a.com']), allow(['a.com', '*.b.com'], ['x.b.com']), true],
    ['allow: allow a platform host (always allowed anyway)', allow(['a.com']), allow(['a.com', 'app.worca.dev']), false],
    ['allow: a wildcard over a platform host is still loosening', allow(['a.com']), allow(['a.com', '*.worca.dev']), true],
    ['allow (empty) → allow (empty)', allow([]), allow([]), false],
    ['allow (empty) → allow with an entry', allow([]), allow(['a.com']), true],
    ['allow: swap one entry for another', allow(['a.com']), allow(['b.com']), true],
  ];
  it.each(cases)('%s', (_name, from, to, loosening) => {
    expect(isLoosening(from, to, platform)).toBe(loosening);
  });

  it('agrees with a brute-force check over many hosts', () => {
    // Every pair of a small universe of policies, checked against concrete hosts.
    const entries = ['a.com', '*.a.com', 'x.a.com', '*.x.a.com', 'b.com', '*.b.com'];
    const hosts = ['a.com', 'x.a.com', 'y.a.com', 'z.x.a.com', 'b.com', 'q.b.com', 'other.org', 'app.worca.dev'];
    const lists = [[], ...entries.map((e) => [e]), ['a.com', '*.b.com'], ['*.a.com', 'b.com'], ['x.a.com', '*.x.a.com']];
    const policies: EgressPolicy[] = [open()];
    for (const d of lists) policies.push(block(...d));
    for (const a of lists) for (const d of lists.slice(0, 5)) policies.push(allow(a, d));
    for (const from of policies) {
      for (const to of policies) {
        const looser = hosts.some((h) => !isHostAllowed(from, h, platform) && isHostAllowed(to, h, platform));
        // Sampling can miss a looser host (an unlisted subdomain), never invent one.
        if (looser) expect(isLoosening(from, to, platform), JSON.stringify({ from, to })).toBe(true);
        if (!isLoosening(from, to, platform)) expect(looser).toBe(false);
      }
    }
  });
});

describe('egressVariables', () => {
  const P = 'app.worca.dev,worca-run-broker.railway.internal';
  it('open: never an empty variable: the platform hosts, and .invalid (blocks nothing) for the blocklist', () => {
    expect(egressVariables(open(), platform)).toEqual({ mode: 'open', allow: P, deny: EMPTY_DENY });
    expect(EMPTY_DENY).toBe('.invalid');
  });
  it('block: the blocklist, wildcards in worca form; the platform hosts as ALLOW', () => {
    expect(egressVariables(block('pastebin.com', '*.ngrok.io'), platform)).toEqual({ mode: 'block', allow: P, deny: 'pastebin.com,.ngrok.io' });
    expect(egressVariables(block(), platform)).toEqual({ mode: 'block', allow: P, deny: EMPTY_DENY });
  });
  it('allow: the platform hosts first, then the allowlist (no duplicates); the blocklist', () => {
    expect(egressVariables(allow(['*.github.com', 'app.worca.dev', 'registry.npmjs.org'], ['gist.github.com']), platform)).toEqual({
      mode: 'allow',
      allow: 'app.worca.dev,worca-run-broker.railway.internal,.github.com,registry.npmjs.org',
      deny: 'gist.github.com',
    });
  });
  it('allow with an empty allowlist still lets worca reach the platform', () => {
    expect(egressVariables(allow([]), platform).allow).toBe('app.worca.dev,worca-run-broker.railway.internal');
  });
  it('worcaEntry', () => {
    expect(worcaEntry('*.a.com')).toBe('.a.com');
    expect(worcaEntry('a.com')).toBe('a.com');
  });
});
