import * as vscode from 'vscode';

export interface EndpointValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  '169.254.170.2',
  '0.0.0.0',
  '[::]',
]);

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function isLinkLocalOrMetadataIp(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_METADATA_HOSTS.has(h) || BLOCKED_METADATA_HOSTS.has(`[${h}]`)) {
    return true;
  }
  // 169.254.0.0/16 link-local / cloud metadata range
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return true;
  }
  // IPv6 link-local fe80::/10 or IPv4-mapped metadata ::ffff:169.254.x.x / ::ffff:a9fe:...
  if (h.startsWith('fe80:') || h.includes('169.254.') || h.startsWith('::ffff:a9fe')) {
    return true;
  }
  return false;
}

/**
 * Validates a provider endpoint URL to prevent SSRF, metadata service probing,
 * credential smuggling in URLs, and non-HTTP(S) schemes.
 */
export function validateEndpointUrl(
  rawUrl: string,
  options: { allowHttp?: boolean; allowHttpLocalhost?: boolean } = {}
): EndpointValidationResult {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Endpoint URL is required.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid endpoint URL format.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Unsupported URL protocol '${parsed.protocol}'. Only HTTP and HTTPS are allowed.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Embedded URL credentials are not permitted. Use API Key authentication instead.' };
  }

  if (!parsed.hostname) {
    return { valid: false, error: 'Endpoint URL must include a valid hostname.' };
  }

  if (isLinkLocalOrMetadataIp(parsed.hostname)) {
    return { valid: false, error: 'Access to link-local and cloud metadata addresses is blocked for security.' };
  }

  if (parsed.protocol === 'http:') {
    const loopback = isLoopbackHost(parsed.hostname);
    if (!options.allowHttp && !(loopback && (options.allowHttpLocalhost ?? true))) {
      return {
        valid: false,
        error: 'Plain HTTP is only permitted for localhost endpoints; remote endpoints must use HTTPS.',
      };
    }
  }

  const normalizedUrl = trimmed.replace(/\/+$/, '');
  return { valid: true, normalizedUrl };
}

export function maskApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  const trimmed = apiKey.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) {
    return '****';
  }
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

/**
 * Redacts API keys and bearer tokens from logs or error messages.
 */
export function redactSecrets(text: string, knownSecrets: Iterable<string> = []): string {
  if (!text) return '';
  let out = text;

  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join('[REDACTED]');
    }
  }

  // Common key/token formats
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+=]+/gi, 'Bearer [REDACTED]');
  out = out.replace(/\b(sk-[A-Za-z0-9\-_]{10,}|sk-ant-[A-Za-z0-9\-_]{10,}|AIza[0-9A-Za-z\-_]{20,})\b/g, '[REDACTED]');
  out = out.replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[REDACTED]');
  return out;
}

/**
 * Backend-only secure API key storage backed by vscode.SecretStorage.
 * Never persists plaintext API keys to Memento, localStorage, or JSON config files.
 */
export class ProviderSecretStore {
  private memoryCache: Map<string, string> = new Map();
  private secretStorage?: vscode.SecretStorage;

  constructor(secretStorage?: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
  }

  private getKeyName(providerId: string): string {
    return `localcoders.provider.apiKey.${providerId}`;
  }

  public async setApiKey(providerId: string, apiKey: string): Promise<void> {
    const cleaned = apiKey.trim();
    if (!cleaned) {
      await this.deleteApiKey(providerId);
      return;
    }
    this.memoryCache.set(providerId, cleaned);
    if (this.secretStorage) {
      await this.secretStorage.store(this.getKeyName(providerId), cleaned);
    }
  }

  public async getApiKey(providerId: string): Promise<string | undefined> {
    if (this.memoryCache.has(providerId)) {
      return this.memoryCache.get(providerId);
    }
    if (this.secretStorage) {
      try {
        const stored = await this.secretStorage.get(this.getKeyName(providerId));
        if (stored) {
          this.memoryCache.set(providerId, stored);
          return stored;
        }
      } catch (err) {
        console.warn(`[ProviderSecretStore] Failed to read secret for '${providerId}'`);
      }
    }
    return undefined;
  }

  public async deleteApiKey(providerId: string): Promise<void> {
    this.memoryCache.delete(providerId);
    if (this.secretStorage) {
      await this.secretStorage.delete(this.getKeyName(providerId));
    }
  }

  public getAllCachedSecrets(): string[] {
    return Array.from(this.memoryCache.values());
  }
}
