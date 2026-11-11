// A tiny OpenID Connect provider for local tests: discovery, JWKS, an authorization endpoint that
// signs in whoever `nextUser` names without asking, and a token endpoint that checks the client
// secret, the redirect URI and the PKCE verifier before issuing an RS256 id token.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export async function startFakeIdp({ clientId = 'e2e-client', clientSecret = randomBytes(16).toString('hex') } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e-1', alg: 'RS256', use: 'sig' };
  const codes = new Map(); // code -> { email, name, redirectUri, challenge }
  const idp = { clientId, clientSecret, issuer: '', nextUser: null, tokenRequests: 0, close: () => {} };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idp.issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/authorize`,
          token_endpoint: `${idp.issuer}/token`,
          jwks_uri: `${idp.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/jwks') return json(200, { keys: [jwk] });
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const p = url.searchParams;
        if (p.get('client_id') !== clientId || p.get('response_type') !== 'code' || !idp.nextUser) return json(400, { error: 'invalid_request' });
        const code = randomBytes(16).toString('hex');
        codes.set(code, { ...idp.nextUser, redirectUri: p.get('redirect_uri'), challenge: p.get('code_challenge') });
        const back = new URL(p.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', p.get('state') ?? '');
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        idp.tokenRequests++;
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const form = new URLSearchParams(raw);
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent) : [form.get('client_id'), form.get('client_secret')];
        if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!grant || form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant' });
        if (grant.challenge) {
          const verifier = form.get('code_verifier') ?? '';
          if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
        }
        const idToken = await new SignJWT({ email: grant.email, name: grant.name, email_verified: true })
          .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
          .setIssuer(idp.issuer)
          .setAudience(clientId)
          .setSubject(`sub-${grant.email}`)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return json(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      }
      json(404, { error: 'not_found' });
    } catch (err) {
      json(500, { error: String(err?.message ?? err) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  idp.issuer = `http://127.0.0.1:${server.address().port}`;
  idp.close = () => new Promise((resolve) => server.close(resolve));
  return idp;
}
