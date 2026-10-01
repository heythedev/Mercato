import { headers } from "next/headers";
import { SCOPES } from "./core";

/**
 * Where we are, taken from the request.
 *
 * The issuer in the metadata has to match the host the client actually
 * reached, exactly — a client that fetched metadata from one origin and is
 * told the issuer is another will refuse, correctly, because that is what an
 * authorization-server-mixup attack looks like. Reading it from the request
 * means localhost, a preview deployment and production are each right about
 * themselves with no constant to keep in step.
 */
export async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. Advertising `plain` would invite a client to use it.
    code_challenge_methods_supported: ["S256"],
    // Public clients: there is no secret to authenticate with, which is the
    // whole reason PKCE is mandatory here.
    token_endpoint_auth_methods_supported: ["none"],
    resource_indicators_supported: true,
  };
}

/** Cached briefly: metadata changes only on deploy, and clients fetch it often. */
export const METADATA_HEADERS = {
  "content-type": "application/json",
  "cache-control": "public, max-age=300",
  // Discovery is fetched cross-origin by a browser-based client.
  "access-control-allow-origin": "*",
};
