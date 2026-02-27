/**
 * GitHub Copilot token manager.
 *
 * GitHub Copilot issues short-lived API tokens (~30 min) that are refreshed
 * using a long-lived GitHub OAuth token stored by LiteLLM at:
 *   ~/.config/litellm/github_copilot/access-token
 *
 * This module provides:
 *   - getToken()  — returns a valid Copilot API token (refreshes if needed)
 *   - startTokenRefresher() — background timer that keeps the token fresh
 *
 * The token is compatible with the standard Anthropic API format when used
 * with ANTHROPIC_BASE_URL set to the Copilot endpoint.
 */

import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import os from 'os';
import { URL } from 'url';
import { logger } from './logger.js';

const OAUTH_TOKEN_PATH = path.join(
  os.homedir(),
  '.config/litellm/github_copilot/access-token',
);

const TOKEN_REFRESH_URL = 'https://api.github.com/copilot_internal/v2/token';

// Refresh when token has less than 5 minutes remaining
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// How often the background timer checks (every 2 minutes)
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  endpoints?: {
    api?: string;
    proxy?: string;
  };
}

let cachedToken: string | null = null;
let cachedExpiresAt: number = 0;
let cachedApiEndpoint: string = 'https://api.individual.githubcopilot.com';

/**
 * Read the GitHub OAuth token from LiteLLM's stored file.
 */
function readOAuthToken(): string {
  try {
    return fs.readFileSync(OAUTH_TOKEN_PATH, 'utf-8').trim();
  } catch (err) {
    throw new Error(
      `GitHub Copilot OAuth token not found at ${OAUTH_TOKEN_PATH}. ` +
        "Run: python3 -c \"import asyncio, litellm; asyncio.run(litellm.acompletion(model='github_copilot/claude-sonnet-4-5', messages=[{'role':'user','content':'hi'}], max_tokens=1))\"",
    );
  }
}

/**
 * Fetch a fresh Copilot API token from GitHub using the OAuth token.
 */
function fetchFreshToken(
  oauthToken: string,
  proxyUrl?: string,
): Promise<CopilotTokenResponse> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(TOKEN_REFRESH_URL);

    const options: https.RequestOptions = {
      hostname: targetUrl.hostname,
      path: targetUrl.pathname,
      method: 'GET',
      headers: {
        Authorization: `token ${oauthToken}`,
        'editor-version': 'vscode/1.85.0',
        'editor-plugin-version': 'copilot/1.0.0',
        'user-agent': 'GithubCopilot/1.0.0',
      },
    };

    let requester: typeof https | typeof http = https;

    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      options.hostname = proxy.hostname;
      options.port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
      options.path = TOKEN_REFRESH_URL;
      options.headers = {
        ...options.headers,
        Host: targetUrl.hostname,
      };
      requester = proxy.protocol === 'https:' ? https : http;
    }

    const req = requester.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(
            new Error(
              `GitHub token refresh failed: HTTP ${res.statusCode} — ${data}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(data) as CopilotTokenResponse);
        } catch (err) {
          reject(new Error(`Failed to parse token response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Refresh the in-memory Copilot token.
 * No-op if the cached token is still fresh enough.
 */
export async function refreshToken(force = false): Promise<void> {
  const now = Date.now();
  const msUntilExpiry = cachedExpiresAt * 1000 - now;

  if (!force && cachedToken && msUntilExpiry > REFRESH_THRESHOLD_MS) {
    return; // still fresh
  }

  const oauthToken = readOAuthToken();
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  logger.info('Refreshing GitHub Copilot token...');
  const response = await fetchFreshToken(oauthToken, proxyUrl);

  cachedToken = response.token;
  cachedExpiresAt = response.expires_at;
  if (response.endpoints?.api) {
    cachedApiEndpoint = response.endpoints.api;
  }

  const expiresInMin = Math.round(
    (cachedExpiresAt * 1000 - Date.now()) / 60000,
  );
  logger.info(
    { expiresInMin, endpoint: cachedApiEndpoint },
    'GitHub Copilot token refreshed',
  );
}

/**
 * Get a valid Copilot API token, refreshing if necessary.
 * Throws if no OAuth token is available.
 */
export async function getToken(): Promise<{
  token: string;
  endpoint: string;
}> {
  await refreshToken();
  if (!cachedToken) {
    throw new Error('No Copilot token available after refresh attempt');
  }
  return { token: cachedToken, endpoint: cachedApiEndpoint };
}

/**
 * Start a background timer that keeps the Copilot token fresh.
 * Call once at startup when Copilot is the configured provider.
 */
export function startTokenRefresher(): void {
  // Immediately refresh on start
  refreshToken(true).catch((err) => {
    logger.error({ err }, 'Initial Copilot token refresh failed');
  });

  setInterval(() => {
    refreshToken().catch((err) => {
      logger.warn({ err }, 'Background Copilot token refresh failed');
    });
  }, REFRESH_INTERVAL_MS);

  logger.info('GitHub Copilot token refresher started');
}
