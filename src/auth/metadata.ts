import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OscarOAuthProvider } from './provider.js';

export interface MetadataDocuments {
  /** RFC 8414 authorization server metadata, served at /.well-known/oauth-authorization-server. */
  authorizationServer: OAuthMetadata;
  /** RFC 9728 protected resource metadata. */
  protectedResource: OAuthProtectedResourceMetadata;
  /** Every path the protected resource document is served from, most specific first. */
  protectedResourcePaths: string[];
  /** The URL advertised in the WWW-Authenticate challenge on a 401 from /mcp. */
  resourceMetadataUrl: string;
}

/**
 * Builds both discovery documents.
 *
 * This exists because the SDK derives everything from `URL.href`, and
 * `new URL('https://mcp.example.com').href` is
 * `'https://mcp.example.com/'`
 * — a trailing slash that the operator's `MCP_PUBLIC_URL` does not have. A
 * client that compares the advertised `issuer` against the URL it was
 * configured with, byte for byte, would reject the server. So the documents the
 * SDK generates are corrected here and served ahead of the SDK's own copies.
 *
 * The SDK's protected-resource route is also mounted only at the RFC 9728
 * path-suffixed location (`/.well-known/oauth-protected-resource/mcp`); several
 * MCP clients still probe the bare path, so both are advertised.
 */
export function buildMetadataDocuments(publicUrl: string, provider: OscarOAuthProvider): MetadataDocuments {
  if (publicUrl.endsWith('/')) {
    throw new Error(`Public URL must not have a trailing slash — it is the OAuth issuer: ${publicUrl}`);
  }

  const issuerUrl = new URL(publicUrl);
  const resourceServerUrl = new URL(`${publicUrl}/mcp`);

  const authorizationServer: OAuthMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl, baseUrl: issuerUrl, scopesSupported: ['mcp'] }),
    issuer: publicUrl
  };

  const protectedResource: OAuthProtectedResourceMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [publicUrl],
    scopes_supported: ['mcp'],
    resource_name: 'Oscar Health Provider Search'
  };

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  return {
    authorizationServer,
    protectedResource,
    protectedResourcePaths: [new URL(resourceMetadataUrl).pathname, '/.well-known/oauth-protected-resource'],
    resourceMetadataUrl
  };
}
