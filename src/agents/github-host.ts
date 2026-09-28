export const GITHUB_PUBLIC_HOST = "github.com";
export const GITHUB_PUBLIC_API_BASE_URL = "https://api.github.com";

export function isGitHubCloudHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === GITHUB_PUBLIC_HOST || normalized.endsWith(".ghe.com");
}

function normalizeGitHubHost(value: string | undefined): string {
  const host = value?.trim().toLowerCase() || GITHUB_PUBLIC_HOST;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) {
    throw new Error("GITHUB_HOST must be a hostname");
  }
  return host;
}

function normalizeGitHubApiBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || GITHUB_PUBLIC_API_BASE_URL;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["", "/", "/api/v3", "/api/v3/"].includes(parsed.pathname)
  ) {
    throw new Error("GITHUB_API_BASE_URL must be an HTTPS origin or /api/v3 endpoint");
  }
  return parsed.pathname.startsWith("/api/v3") ? `${parsed.origin}/api/v3` : parsed.origin;
}

export function resolveGitHubHost(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeGitHubHost(env.GITHUB_HOST);
}

function resolveGitHubApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeGitHubApiBaseUrl(env.GITHUB_API_BASE_URL);
}

export function resolveGitHubAppApiBaseUrl(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (host !== resolveGitHubHost(env)) {
    throw new Error("GITHUB_API_BASE_URL must match GITHUB_HOST");
  }
  const apiBaseUrl = resolveGitHubApiBaseUrl(env);
  const api = new URL(apiBaseUrl);
  const cloud = host === GITHUB_PUBLIC_HOST || host.endsWith(".ghe.com");
  const expectedApiHost =
    host === GITHUB_PUBLIC_HOST
      ? "api.github.com"
      : host.endsWith(".ghe.com")
        ? `api.${host}`
        : host;
  if (api.hostname !== expectedApiHost || api.pathname !== (cloud ? "/" : "/api/v3")) {
    throw new Error("GITHUB_API_BASE_URL must match GITHUB_HOST");
  }
  return apiBaseUrl;
}
