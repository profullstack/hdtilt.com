// Accounts: a username, an email that has been proved, a password, and one
// "library" per account (playlists, favorites, recents) synced across devices.
//
// Built on @profullstack/auth-system. Password login is the point here: a TV
// has no mail client to open a magic link in and no authenticator for a
// passkey, and hdtilt lives on TVs. The email is still verified before the
// account can sign in, and it is how a forgotten password comes back.
//
// The library holds provider logins, so it is encrypted at rest (AES-256-GCM,
// HDTILT_LIBRARY_KEY) and never logged.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AuthSystem, MemoryAdapter, PostgresAdapter } from '@profullstack/auth-system';
import { createOAuthServer, memoryStore as oauthMemoryStore } from '@profullstack/auth-system/oauth2';
import { OAUTH2_SCHEMA, postgresStore as oauthPostgresStore } from '@profullstack/auth-system/oauth2/postgres';
import { createEmailer } from '@profullstack/emailer';
import jwt from 'jsonwebtoken';

/** The CLI, TUI and stdio MCP sign in as this client (code + PKCE, loopback). */
export const CLI_CLIENT_ID = 'hdtilt-cli';
export const OAUTH_PREFIX = 'ht';

/**
 * A tagged-template `sql` over the pg pool the accounts adapter already holds,
 * so the OAuth store and the accounts share one connection pool and one driver.
 */
function sqlOver(adapter) {
  const sql = async (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + (i ? `$${i}` : '') + part, '');
    return (await adapter.query(text, values)).rows;
  };
  sql.unsafe = async (text) => (await adapter.query(text)).rows;
  return sql;
}

const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,29}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LIBRARY = 4 << 20; // a playlist list with logins, not the channels themselves

/** Library ciphertext: base64(iv | tag | data). */
function sealer(keyText) {
  // A missing key still encrypts (tests, a local install) but with a key derived
  // from the JWT secret, so nothing is ever stored in the clear.
  const key = createHash('sha256').update(String(keyText)).digest();
  return {
    seal(obj) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
    },
    open(text) {
      const buf = Buffer.from(text, 'base64');
      const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
    },
  };
}

/** Where usernames and libraries live: Postgres in production, memory otherwise. */
function postgresStore(adapter) {
  let ready = null;
  const init = () =>
    (ready ??= (async () => {
      await adapter.initialize();
      await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${adapter.usersTable}_username_key
        ON ${adapter.usersTable} (lower(profile->>'username'))`);
      await adapter.query(OAUTH2_SCHEMA);
      await adapter.query(`CREATE TABLE IF NOT EXISTS hdtilt_libraries (
        user_id TEXT PRIMARY KEY,
        blob TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    })());
  return {
    init,
    async emailForUsername(username) {
      await init();
      const { rows } = await adapter.query(
        `SELECT email FROM ${adapter.usersTable} WHERE lower(profile->>'username') = lower($1)`,
        [username],
      );
      return rows[0]?.email || null;
    },
    async getLibrary(userId) {
      await init();
      const { rows } = await adapter.query(
        'SELECT blob, version, updated_at FROM hdtilt_libraries WHERE user_id = $1',
        [userId],
      );
      return rows[0] ? { blob: rows[0].blob, version: rows[0].version, updatedAt: rows[0].updated_at } : null;
    },
    /** Write when `base` matches the stored version; null when someone else wrote first. */
    async putLibrary(userId, blob, base) {
      await init();
      const { rows } = await adapter.query(
        `INSERT INTO hdtilt_libraries (user_id, blob) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET blob = EXCLUDED.blob,
           version = hdtilt_libraries.version + 1, updated_at = now()
         WHERE $3::int IS NULL OR hdtilt_libraries.version = $3::int
         RETURNING version, updated_at`,
        [userId, blob, base ?? null],
      );
      return rows[0] ? { version: rows[0].version, updatedAt: rows[0].updated_at } : null;
    },
  };
}

function memoryStore(adapter) {
  const libs = new Map();
  return {
    init: async () => {},
    async emailForUsername(username) {
      const all = adapter.users ? [...adapter.users.values()] : [];
      const u = all.find((x) => x.profile?.username?.toLowerCase() === username.toLowerCase());
      return u?.email || null;
    },
    async getLibrary(userId) {
      return libs.get(userId) || null;
    },
    async putLibrary(userId, blob, base) {
      const cur = libs.get(userId);
      if (cur && base != null && cur.version !== base) return null;
      const next = { blob, version: (cur?.version || 0) + 1, updatedAt: new Date() };
      libs.set(userId, next);
      return { version: next.version, updatedAt: next.updatedAt };
    },
  };
}

const page = (
  title,
  body,
) => `<!doctype html><html><body style="margin:0;background:#0b0f14;font-family:system-ui,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#e8eef5">
<h1 style="font-size:22px;margin:0 0 16px">${title}</h1>${body}
<p style="color:#8b98a8;font-size:13px;margin-top:28px">hdtilt · open-source IPTV player · <a style="color:#38bdf8" href="https://hdtilt.com">hdtilt.com</a></p>
</div></body></html>`;
const button = (href, label) =>
  `<p><a href="${href}" style="display:inline-block;background:#38bdf8;color:#04131c;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none">${label}</a></p><p style="color:#8b98a8;font-size:13px;word-break:break-all">${href}</p>`;

/**
 * @param {{ env?: Record<string,string|undefined>, sendEmail?: Function, adapter?: object }} [opts]
 */
export function createAccounts(opts = {}) {
  const env = opts.env || process.env;
  const secret = env.HDTILT_JWT_SECRET;
  if (!secret && !opts.adapter) return null; // accounts off: a local install needs none
  const site = (env.SITE_URL || 'https://hdtilt.com').replace(/\/$/, '');
  const from = env.MAIL_FROM || 'hdtilt <noreply@hdtilt.com>';

  let sendEmail = opts.sendEmail;
  if (!sendEmail && env.RESEND_API_KEY) {
    const emailer = createEmailer({ resendApiKey: env.RESEND_API_KEY });
    sendEmail = async (m) => {
      const r = await emailer.send({ from, to: m.to, subject: m.subject, html: m.html, text: m.text });
      if (r && r.sent === false) throw new Error('could not send email');
      return r;
    };
  }
  if (!sendEmail) {
    // No mail service: a local install prints the message (links included) so
    // the account can still be confirmed; a public server says only that it could not send.
    const local = env.HDTILT_PUBLIC !== '1';
    sendEmail = async (m) =>
      console.warn(
        local
          ? `hdtilt mail to ${m.to}: ${m.subject}\n${m.text}`
          : `hdtilt: RESEND_API_KEY unset; "${m.subject}" not sent`,
      );
  }

  const adapter =
    opts.adapter ||
    (env.DATABASE_URL ? new PostgresAdapter({ connectionString: env.DATABASE_URL }) : new MemoryAdapter());
  const store = adapter instanceof PostgresAdapter ? postgresStore(adapter) : memoryStore(adapter);
  const box = sealer(env.HDTILT_LIBRARY_KEY || `${secret || 'dev'}:library`);

  const auth = new AuthSystem({
    adapter,
    tokenOptions: { secret: secret || 'hdtilt-dev-secret', accessTokenExpiry: 3600, refreshTokenExpiry: 90 * 86400 },
    passwordOptions: {
      minLength: 8,
      requireUppercase: false,
      requireLowercase: false,
      requireNumbers: false,
      requireSpecialChars: false,
    },
    emailOptions: {
      sendEmail,
      fromEmail: from,
      verificationTemplate: ({ token }) => {
        const link = `${site}/verify?token=${encodeURIComponent(token)}`;
        return {
          subject: 'Confirm your email for hdtilt',
          text: `Confirm your email to finish creating your hdtilt account:\n\n${link}\n\nThe link works for 24 hours. If you did not sign up, ignore this email.`,
          html: page(
            'Confirm your email',
            `<p>One step left: confirm this address to finish creating your hdtilt account.</p>${button(link, 'Confirm email')}<p style="color:#8b98a8">The link works for 24 hours. If you did not sign up, ignore this email.</p>`,
          ),
        };
      },
      resetPasswordTemplate: ({ token }) => {
        const link = `${site}/reset?token=${encodeURIComponent(token)}`;
        return {
          subject: 'Reset your hdtilt password',
          text: `Choose a new password for hdtilt:\n\n${link}\n\nIf you did not ask for this, ignore this email; your password has not changed.`,
          html: page(
            'Reset your password',
            `<p>Choose a new password for your hdtilt account.</p>${button(link, 'Choose a new password')}<p style="color:#8b98a8">If you did not ask for this, ignore this email; your password has not changed.</p>`,
          ),
        };
      },
    },
  });

  const oauth = createOAuthServer({
    store: adapter instanceof PostgresAdapter ? oauthPostgresStore(sqlOver(adapter)) : oauthMemoryStore(),
    issuer: site,
    tokenPrefix: OAUTH_PREFIX,
    clients: {
      [CLI_CLIENT_ID]: { name: 'hdtilt CLI and TUI', redirectUris: ['http://127.0.0.1/callback', `${site}/oauth/cli`] },
    },
  });

  const publicUser = (u) => ({
    id: u.id,
    email: u.email,
    username: u.profile?.username || null,
    emailVerified: Boolean(u.emailVerified),
  });

  async function whoFrom(authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(authorization || '');
    if (!m) return null;
    // A CLI or TUI signed in through OAuth carries an opaque ht_at_ token.
    if (m[1].startsWith(`${OAUTH_PREFIX}_at_`)) {
      await store.init();
      const t = await oauth.verifyAccessToken(m[1]);
      return t ? { userId: t.userId, via: 'oauth' } : null;
    }
    try {
      const claims = await auth.validateToken(m[1]);
      return claims?.userId ? claims : null;
    } catch {
      return null;
    }
  }

  return {
    store,
    auth,
    oauth,
    /** Validate an /oauth/authorize query, then approve or deny it for a signed-in user. */
    async authorize(claims, query, decision) {
      await store.init();
      const p = oauth.validateAuthorize(query);
      if (decision === 'deny') return { redirect: oauth.denyUrl({ redirectUri: p.redirectUri, state: query.state }) };
      if (decision === 'approve') {
        return {
          redirect: await oauth.approve({
            userId: claims.userId,
            clientId: p.clientId,
            redirectUri: p.redirectUri,
            codeChallenge: p.codeChallenge,
            scope: p.scope,
            state: query.state,
          }),
        };
      }
      return { clientName: p.clientName, scope: p.scope };
    },
    async token(body) {
      await store.init();
      return oauth.token(body);
    },
    async revoke(token) {
      await store.init();
      await oauth.revoke(token);
    },
    async register({ username, email, password }) {
      username = String(username || '').trim();
      email = String(email || '')
        .trim()
        .toLowerCase();
      if (!USERNAME.test(username))
        throw new Error('Pick a username of 3 to 30 letters, numbers, dots, dashes or underscores');
      if (!EMAIL.test(email)) throw new Error('That email address does not look right');
      if (String(password || '').length < 8) throw new Error('Use a password of at least 8 characters');
      await store.init();
      if (await store.emailForUsername(username)) throw new Error('That username is taken');
      try {
        await auth.register({ email, password, profile: { username } });
      } catch (e) {
        // Same answer whether or not the address exists, so the form cannot be
        // used to find out who has an account.
        if (/exist/i.test(e.message)) return { ok: true, sent: true };
        if (/unique|duplicate/i.test(e.message)) throw new Error('That username is taken');
        throw e;
      }
      return { ok: true, sent: true };
    },
    async verify(token) {
      let r;
      try {
        r = await auth.verifyEmail(token);
      } catch {
        // A link clicked twice: say "already confirmed" rather than "broken",
        // but only for a link we signed, so this cannot probe accounts.
        try {
          const p = jwt.verify(String(token), secret || 'hdtilt-dev-secret');
          const u = p?.type === 'email_verification' && (await adapter.getUserById(p.userId));
          if (u?.emailVerified) {
            const err = new Error('This email is already confirmed. Sign in to continue.');
            err.code = 'already_verified';
            throw err;
          }
        } catch (inner) {
          if (inner.code === 'already_verified') throw inner;
        }
        throw new Error('That link has expired or was already used. Sign in, or ask for a new one.');
      }
      // verifyEmail hands back the user as it was before the update.
      return { user: publicUser((await adapter.getUserById(r.user.id)) || r.user), tokens: r.tokens };
    },
    async login({ login, password }) {
      const id = String(login || '').trim();
      const email = id.includes('@') ? id.toLowerCase() : await store.emailForUsername(id);
      if (!email) throw new Error('Wrong username or password');
      try {
        const r = await auth.login({ email, password });
        return { user: publicUser(r.user), tokens: r.tokens };
      } catch (e) {
        if (/verif/i.test(e.message)) {
          const err = new Error('Confirm your email first: check your inbox, or send the link again');
          err.code = 'unverified';
          err.email = email;
          throw err;
        }
        throw new Error('Wrong username or password');
      }
    },
    async resendVerification(email) {
      const u = await adapter.getUserByEmail(
        String(email || '')
          .trim()
          .toLowerCase(),
      );
      if (u && !u.emailVerified) {
        const token = await auth.tokenUtils.generateEmailVerificationToken(u.id);
        await auth._sendVerificationEmail(u.email, token);
      }
      return { ok: true };
    },
    async forgot(email) {
      try {
        await auth.resetPassword(
          String(email || '')
            .trim()
            .toLowerCase(),
        );
      } catch {}
      return { ok: true };
    },
    async reset({ token, password }) {
      if (String(password || '').length < 8) throw new Error('Use a password of at least 8 characters');
      await auth.resetPasswordConfirm({ token, password });
      return { ok: true };
    },
    async refresh(refreshToken) {
      const r = await auth.refreshToken(refreshToken);
      return { tokens: r.tokens };
    },
    async logout({ refreshToken, accessToken }) {
      try {
        await auth.logout(refreshToken, accessToken);
      } catch {}
      return { ok: true };
    },
    whoFrom,
    async me(claims) {
      const u = await adapter.getUserById(claims.userId);
      if (!u) throw new Error('No such account');
      return publicUser(u);
    },
    async getLibrary(claims) {
      const row = await store.getLibrary(claims.userId);
      if (!row) return { data: null, version: 0 };
      return { data: box.open(row.blob), version: row.version, updatedAt: row.updatedAt };
    },
    async putLibrary(claims, { data, baseVersion }) {
      const blob = box.seal(data ?? {});
      if (blob.length > MAX_LIBRARY) throw new Error('That library is too large to sync');
      const r = await store.putLibrary(claims.userId, blob, baseVersion);
      if (!r) {
        const err = new Error('Changed on another device; pull first');
        err.code = 'conflict';
        throw err;
      }
      return r;
    },
  };
}
