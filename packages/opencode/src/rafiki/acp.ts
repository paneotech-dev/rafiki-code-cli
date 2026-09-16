// rafikicode acp without a Rafiki key: the agent still starts and answers
// initialize, so the editor can show the sign in action (terminal auth runs
// rafikicode login). authenticate, session/new and session/prompt answer the
// ACP auth_required error (-32000) with the same message as run and the
// terminal interface, instead of opening a session that cannot answer.
import path from "path"
import { RequestError } from "@agentclientprotocol/sdk"
import { Brand } from "@opencode-ai/core/brand/brand"
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
