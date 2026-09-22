import crypto from 'node:crypto'
import http from 'node:http'
import open from 'open'

// Loopback-redirect PKCE (HOL-128) — same pattern `gh auth login --web`,
// `vercel login`, and `supabase login` use: a browser round trip against
// Holodeck's own OAuth server (HOL-125/126), landing on a local HTTP
// server instead of a hosted callback page. One run = one *person* signed
// in (HOL-132): this client (`holodeck-cli`) never gets the Agent picker
// Claude Desktop/Code do, and its token carries no Agent identity - the
// Agent is chosen later, by the setup command itself (`channel add`, ...),
// which asks Holodeck for a token scoped to that one Agent (holodeckApi.ts).
//
// `CLIENT_ID_URL` and `LOOPBACK_PORT` mirror
// backend/src/auth/holodeckCliClientMetadata.ts in the task-manager repo
// exactly — that file is the source of truth (it's what actually serves
// the Client ID Metadata Document these values describe). This CLI is a
// separate package/repo with no way to import that file directly, so
// these are duplicated by hand; keep them in sync if that document ever
// moves or the port changes.
const CLIENT_ID_URL = 'https://api.holodeck-tracker.com/.well-known/oauth-client-metadata/holodeck-cli.json'
const LOOPBACK_PORT = 44816
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`
const OAUTH_SCOPE = 'openid profile email offline_access'
// The user has up to 5 minutes to finish the browser flow before this
// gives up and the local server closes — long enough for "switch to the
// browser, sign in, click Allow" without leaving a listening socket open
// indefinitely if they abandon it.
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

function base64url(input: Buffer): string {
  return input.toString('base64url')
}

// RFC 7636 - a `code_verifier` is a random string (43-128 chars once
// base64url-encoded); `code_challenge` is its SHA-256 digest, also
// base64url. The server never sees `code_verifier` until the token
// exchange, so a stolen authorization code alone (e.g. leaked via a
// referrer header) can't be redeemed without it.
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

export interface LoginTokens {
  accessToken: string
  refreshToken: string
  // Epoch ms - compared against Date.now() to decide when to refresh.
  expiresAt: number
}

// Waits for exactly one GET to `REDIRECT_URI`'s path carrying the expected
// `state` (CSRF protection - rejects a callback that doesn't match this
// specific flow's own authorize request), responds with a short HTML page
// mirroring Claude Code's own "you can close this tab" convention (seen
// live during HOL-126's Claude Code testing), then closes the server.
function waitForAuthorizationCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }

      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      const respondAndClose = (html: string) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
        server.close()
      }

      if (error) {
        respondAndClose(`<h1>Sign-in failed</h1><p>${error}</p><p>You can close this tab.</p>`)
        reject(new Error(`Authorization failed: ${error}`))
        return
      }
      if (state !== expectedState) {
        respondAndClose('<h1>Sign-in failed</h1><p>State mismatch — this callback does not belong to the login attempt currently running.</p>')
        reject(new Error('OAuth state mismatch'))
        return
      }
      if (!code) {
        respondAndClose('<h1>Sign-in failed</h1><p>No authorization code was returned.</p>')
        reject(new Error('No authorization code in callback'))
        return
      }

      respondAndClose('<h1>Signed in</h1><p>You can close this tab and return to your terminal.</p>')
      resolve(code)
    })

    server.on('error', reject)

    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for the browser sign-in to complete.'))
    }, CALLBACK_TIMEOUT_MS)
    server.once('close', () => clearTimeout(timeout))

    server.listen(LOOPBACK_PORT, '127.0.0.1')
  })
}

// A rejected token request (HTTP status kept), as opposed to the network
// being unreachable - a refresh that is *rejected* means the login is over
// (expired/revoked refresh token), while an unreachable server is worth
// retrying later without throwing the login away.
export class TokenRequestError extends Error {
  status: number

  constructor(status: number, body: string) {
    super(`Token request failed (${status}): ${body}`)
    this.status = status
  }
}

// Both grants (the initial code exchange and the refresh) hit the same
// endpoint with the same encoding.
async function requestTokens(serverUrl: string, params: Record<string, string>): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({ ...params, client_id: CLIENT_ID_URL })
  // Form-encoded, not JSON - the OAuth token endpoint only accepts
  // `application/x-www-form-urlencoded` per spec (HOL-126 found this the
  // hard way: Holodeck's own backend 415'd a JSON body here before that
  // fix landed).
  const response = await fetch(new URL('/api/auth/oauth2/token', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    throw new TokenRequestError(response.status, await response.text())
  }
  return (await response.json()) as OAuthTokenResponse
}

function toLoginTokens(tokens: OAuthTokenResponse, currentRefreshToken?: string): LoginTokens {
  // SAFETY: the initial grant is requested with the `offline_access` scope
  // above, which Holodeck's OAuth server always pairs with a refresh token
  // (HOL-126) - absent only if that scope was somehow dropped, which would
  // itself be a server-side bug worth failing loudly
  // on rather than silently storing a credential with no way to ever renew
  // itself. A refresh response may not rotate it, in which case the
  // current one stays valid.
  const refreshToken = tokens.refresh_token ?? currentRefreshToken
  if (!refreshToken) {
    throw new Error('Holodeck did not return a refresh token — cannot store a durable login.')
  }
  return { accessToken: tokens.access_token, refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000 }
}

// The `refresh_token` grant (HOL-132) - what keeps a login alive past the
// access token's 1h lifetime (the refresh token itself lasts 30 days).
export async function refreshLoginTokens(serverUrl: string, refreshToken: string): Promise<LoginTokens> {
  const tokens = await requestTokens(serverUrl, { grant_type: 'refresh_token', refresh_token: refreshToken })
  return toLoginTokens(tokens, refreshToken)
}

// The whole flow, end to end: opens the browser, waits for the person to
// finish it there, and exchanges the code for tokens. Nothing else is
// resolved here - there is no Agent identity in this token to look up.
export async function loginWithBrowser(serverUrl: string): Promise<LoginTokens> {
  const { verifier, challenge } = createPkcePair()
  const state = base64url(crypto.randomBytes(16))

  const authorizeUrl = new URL('/api/auth/oauth2/authorize', serverUrl)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', CLIENT_ID_URL)
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('scope', OAUTH_SCOPE)
  // Without an explicit `resource` (RFC 8707), Holodeck's OAuth provider
  // issues an opaque access token with no `aud`/custom claims at all - it
  // only signs a real JWT when a request asks for one specific resource. A
  // real MCP client like Claude Code discovers this via the
  // protected-resource metadata and always sends it; this CLI skips that
  // discovery step and hardcodes the same resource identifier Holodeck's
  // own backend always advertises for `serverUrl` instead.
  authorizeUrl.searchParams.set('resource', new URL('/mcp', serverUrl).toString())

  const codePromise = waitForAuthorizationCode(state)

  console.log('Opening your browser to sign in...')
  console.log(`If it didn't open, visit:\n  ${authorizeUrl.toString()}\n`)
  await open(authorizeUrl.toString())

  const code = await codePromise
  const tokens = await requestTokens(serverUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  })
  return toLoginTokens(tokens)
}
