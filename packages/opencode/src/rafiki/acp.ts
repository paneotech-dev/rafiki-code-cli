// rafikicode acp without a Rafiki key: the agent still starts and answers
// initialize, so the editor can show the sign in action (terminal auth runs
// rafikicode login). authenticate, session/new and session/prompt answer the
// ACP auth_required error (-32000) with the same message as run and the
// terminal interface, instead of opening a session that cannot answer.
import path from "path"
import { randomBytes } from "crypto"
import { RequestError } from "@agentclientprotocol/sdk"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as BrandServe from "@opencode-ai/core/brand/serve"
import * as MissingKey from "./missing-key"

export function authRequired() {
  if (Brand.providers.open() || !MissingKey.missing()) return undefined
  return RequestError.authRequired({ authMethods: [Brand.acp.authMethod] }, MissingKey.noKey())
}

// Runs call unless a key is missing, in which case it rejects with auth_required.
export function withKey<A>(call: () => Promise<A>): Promise<A> {
  const error = authRequired()
  return error ? Promise.reject(error) : call()
}

// The auth method ids authenticate accepts: ours, then the upstream one.
export function knownAuthMethod(id: string) {
  return id === Brand.acp.authMethod || Brand.acp.legacyAuthMethods.includes(id)
}

// authenticate: an unknown method keeps the upstream invalid params answer;
// a known one succeeds only once a key exists (after rafikicode login).
export function authenticate<A>(methodId: string, call: () => Promise<A>): Promise<A> {
  return knownAuthMethod(methodId) ? withKey(call) : call()
}

// The command an editor runs for terminal auth. Editors started from a desktop
// launcher often lack the shell PATH, so a built binary names itself by its
// absolute path; a source run (bun) keeps the bare name.
export function loginCommand(execPath: string = process.execPath) {
  const base = path.basename(execPath).toLowerCase()
  return base === Brand.name || base === `${Brand.name}.exe` ? execPath : Brand.name
}

// The arguments of that command: an editor sign in reaches the Console as
// surface ide, so the key list shows where the key is used.
export function loginArgs() {
  return ["login", "--surface", "ide"]
}

// rafikicode acp talks to its own local HTTP server, and only this process
// uses it. Without a password any program or user on the machine could use
// that server too: read files anywhere (the credentials file included) and
// open a terminal. So when no password is set, acp makes a random one for
// this process: the server requires it and the ACP client sends it.
//
// serverSecret() applies the listen rule first (an address other machines can
// reach still needs a password the person chose, BrandServe.refused), then
// puts the password in the environment for the listener to read; undefined
// means acp must stop. forget() takes a generated password out of the
// environment once the listener runs, so tools, terminals and MCP servers
// started later do not inherit it.
export function serverSecret(opts: { hostname: string }, env: Record<string, string | undefined> = process.env) {
  const existing = Brand.server.password(env)
  if (existing || !BrandServe.loopback(opts.hostname)) {
    if (BrandServe.refused(opts)) return undefined
    return { password: existing ?? "", generated: false }
  }
  const password = randomBytes(32).toString("base64url")
  env[Brand.server.env.password] = password
  return { password, generated: true }
}

export function forget(secret: { password: string; generated: boolean }, env: Record<string, string | undefined> = process.env) {
  if (secret.generated && env[Brand.server.env.password] === secret.password) delete env[Brand.server.env.password]
}

// The providers as an editor's model list shows them: tiers the brand layer
// keeps unlisted (Brand.provider.unlisted) are left out, unless the session
// already uses one, which stays listed as the current choice. Model lookups
// use the full provider list, so an explicit unlisted model still works.
export function listedProviders<P extends { id: string; models: Record<string, unknown> }>(
  providers: readonly P[],
  current?: { providerID: string; modelID: string },
): P[] {
  return providers.map((provider) => ({
    ...provider,
    models: Object.fromEntries(
      Object.entries(provider.models).filter(
        ([id]) => Brand.provider.listed(provider.id, id) || (current?.providerID === provider.id && current.modelID === id),
      ),
    ),
  }))
}
