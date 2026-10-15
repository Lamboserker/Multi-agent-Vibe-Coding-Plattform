import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export interface OAuthVault {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

/** SDK owns discovery, registration, PKCE and refresh; this class owns secure storage and UI. */
export class McpOAuthProvider implements OAuthClientProvider {
  private verifier?: string
  private listener?: Server
  private callbackUrl?: string
  private expectedState?: string
  private authUrl?: string
  private onCode?: (code: string) => Promise<void>
  private expires?: NodeJS.Timeout
  constructor(private readonly vault: OAuthVault, private readonly config: { clientId?: string; scope?: string } = {}) {}
  get redirectUrl() { return this.callbackUrl }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Multi-AI Coder', redirect_uris: this.callbackUrl ? [this.callbackUrl] : [], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(this.config.scope ? { scope: this.config.scope } : {}) }
  }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId) return { client_id: this.config.clientId }
    const raw = await this.vault.get('oauth-client')
    return raw ? JSON.parse(raw) : undefined
  }
  async saveClientInformation(value: OAuthClientInformationMixed) { await this.vault.set('oauth-client', JSON.stringify(value)) }
  async tokens(): Promise<OAuthTokens | undefined> { const raw = await this.vault.get('oauth-tokens'); return raw ? JSON.parse(raw) : undefined }
  async saveTokens(value: OAuthTokens) { await this.vault.set('oauth-tokens', JSON.stringify(value)) }
  state() { if (!this.expectedState) throw new Error('Start OAuth from the MCP manager.'); return this.expectedState }
  saveCodeVerifier(value: string) { this.verifier = value }
  codeVerifier() { if (!this.verifier) throw new Error('OAuth login expired; start it again.'); return this.verifier }
  redirectToAuthorization(url: URL) {
    if (!this.listener) throw new Error('OAuth login required: use the MCP manager → OAuth anmelden.')
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('OAuth authorization endpoint must use HTTPS.')
    this.authUrl = url.href
  }
  get authorizationUrl() { return this.authUrl }
  /** Without stored tokens a connection cannot authenticate; fail with an instruction instead of an SDK error. */
  async requireLogin() {
    if (!this.listener && !(await this.tokens())) throw new Error('OAuth login required: MCP manager → server → "OAuth anmelden".')
  }
  async begin(onCode: (code: string) => Promise<void>) {
    await this.cancel()
    this.expectedState = randomBytes(32).toString('hex')
    this.onCode = onCode
    this.listener = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', this.callbackUrl)
        if (url.pathname !== '/callback' || !url.searchParams.get('state') || url.searchParams.get('state') !== this.expectedState) { res.writeHead(400).end('Invalid OAuth state.'); return }
        const code = url.searchParams.get('code')
        if (!code || url.searchParams.has('error')) { res.writeHead(400).end('OAuth authorization cancelled.'); await this.cancel(); return }
        this.expectedState = undefined // single use
        try { await this.onCode!(code); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Anmeldung abgeschlossen. Du kannst dieses Fenster schließen.') }
        catch { res.writeHead(400).end('OAuth token exchange failed. Check the MCP manager.'); }
        finally { await this.cancel() }
      })().catch(() => res.writeHead(500).end('OAuth callback failed.'))
    })
    await new Promise<void>((resolve, reject) => { this.listener!.once('error', reject); this.listener!.listen(0, '127.0.0.1', resolve) })
    this.callbackUrl = `http://127.0.0.1:${(this.listener.address() as { port: number }).port}/callback`
    this.expires = setTimeout(() => void this.cancel(), 5 * 60_000)
    this.expires.unref()
  }
  async cancel() {
    if (this.expires) clearTimeout(this.expires)
    this.listener?.close()
    this.listener = undefined
    this.expectedState = undefined
    this.verifier = undefined
    this.authUrl = undefined
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') await this.vault.delete('oauth-tokens')
    if (scope === 'all' || scope === 'client') await this.vault.delete('oauth-client')
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
  }
}
