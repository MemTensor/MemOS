import Store from 'electron-store';
import { app } from 'electron';
import * as crypto from 'crypto';
import * as os from 'os';

/**
 * Secure storage using electron-store with custom AES-256-GCM encryption.
 *
 * This implementation derives an encryption key from machine-specific values
 * (hostname, platform, user home directory, app path) to avoid macOS Keychain
 * prompts while still providing reasonable security for API keys.
 *
 * Security considerations:
 * - Keys are encrypted at rest using AES-256-GCM
 * - Encryption key is derived from machine-specific data (not stored)
 * - Less secure than Keychain (key derivation could be reverse-engineered)
 * - Suitable for API keys that can be rotated if compromised
 */

// Use different store names for dev vs production to avoid conflicts
const getStoreName = () => (app.isPackaged ? 'secure-storage' : 'secure-storage-dev');

interface SecureStorageSchema {
  /** Encrypted values stored as base64 strings (format: iv:authTag:ciphertext) */
  values: Record<string, string>;
  /** Salt for key derivation (generated once per installation) */
  salt?: string;
}

// Lazy initialization to ensure app is ready
let _secureStore: Store<SecureStorageSchema> | null = null;
let _derivedKey: Buffer | null = null;

function getSecureStore(): Store<SecureStorageSchema> {
  if (!_secureStore) {
    _secureStore = new Store<SecureStorageSchema>({
      name: getStoreName(),
      defaults: { values: {} },
    });
  }
  return _secureStore;
}

/**
 * Get or create a salt for key derivation.
 * The salt is stored in the config file and generated once per installation.
 */
function getSalt(): Buffer {
  const store = getSecureStore();
  let saltBase64 = store.get('salt');

  if (!saltBase64) {
    // Generate a new random salt
    const salt = crypto.randomBytes(32);
    saltBase64 = salt.toString('base64');
    store.set('salt', saltBase64);
  }

  return Buffer.from(saltBase64, 'base64');
}

/**
 * Derive an encryption key from machine-specific data.
 * This is deterministic for the same machine/installation.
 *
 * Note: We avoid hostname as it can be changed by users (renaming laptop).
 */
function getDerivedKey(): Buffer {
  if (_derivedKey) {
    return _derivedKey;
  }

  // Combine machine-specific values to create a unique identifier
  const machineData = [
    os.platform(),
    os.homedir(),
    os.userInfo().username,
    app.getPath('userData'),
    'ai.accomplish.desktop', // App identifier
  ].join(':');

  const salt = getSalt();

  // Use PBKDF2 to derive a 256-bit key
  _derivedKey = crypto.pbkdf2Sync(
    machineData,
    salt,
    100000, // iterations
    32, // key length (256 bits)
    'sha256'
  );

  return _derivedKey;
}

/**
 * Encrypt a string using AES-256-GCM.
 * Returns format: iv:authTag:ciphertext (all base64)
 */
function encryptValue(value: string): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12); // GCM recommended IV size

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(value, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a value encrypted with encryptValue.
 */
function decryptValue(encryptedData: string): string | null {
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      // Invalid format
      return null;
    }

    const [ivBase64, authTagBase64, ciphertext] = parts;
    const key = getDerivedKey();
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch {
    // Decryption failed (wrong key, corrupted data, etc.)
    // Don't log error details to avoid leaking sensitive context
    return null;
  }
}

/**
 * Store an API key securely
 */
export function storeApiKey(provider: string, apiKey: string): void {
  const store = getSecureStore();
  const encrypted = encryptValue(apiKey);
  const values = store.get('values');
  values[`apiKey:${provider}`] = encrypted;
  store.set('values', values);
}

/**
 * Retrieve an API key
 */
export function getApiKey(provider: string): string | null {
  const store = getSecureStore();
  const values = store.get('values');
  if (!values) {
    return null;
  }
  const encrypted = values[`apiKey:${provider}`];
  if (!encrypted) {
    return null;
  }
  return decryptValue(encrypted);
}

/**
 * Delete an API key
 */
export function deleteApiKey(provider: string): boolean {
  const store = getSecureStore();
  const values = store.get('values');
  const key = `apiKey:${provider}`;
  if (!(key in values)) {
    return false;
  }
  delete values[key];
  store.set('values', values);
  return true;
}

/**
 * Supported API key providers
 */
export type ApiKeyProvider = 'anthropic' | 'openai' | 'openrouter' | 'google' | 'xai' | 'deepseek' | 'zai' | 'custom' | 'bedrock' | 'litellm';

/**
 * Get all API keys for all providers
 */
export async function getAllApiKeys(): Promise<Record<ApiKeyProvider, string | null>> {
  const [anthropic, openai, openrouter, google, xai, deepseek, zai, custom, bedrock, litellm] = await Promise.all([
    getApiKey('anthropic'),
    getApiKey('openai'),
    getApiKey('openrouter'),
    getApiKey('google'),
    getApiKey('xai'),
    getApiKey('deepseek'),
    getApiKey('zai'),
    getApiKey('custom'),
    getApiKey('bedrock'),
    getApiKey('litellm'),
  ]);

  return { anthropic, openai, openrouter, google, xai, deepseek, zai, custom, bedrock, litellm };
}

/**
 * Store Bedrock credentials (JSON stringified)
 */
export function storeBedrockCredentials(credentials: string): void {
  storeApiKey('bedrock', credentials);
}

/**
 * Get Bedrock credentials (returns parsed object or null)
 */
export function getBedrockCredentials(): Record<string, string> | null {
  const stored = getApiKey('bedrock');
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/**
 * Check if any API key is stored
 */
export async function hasAnyApiKey(): Promise<boolean> {
  const keys = await getAllApiKeys();
  return Object.values(keys).some((k) => k !== null);
}

/**
 * List all stored credentials for this service
 * Returns key names with their (decrypted) values
 */
export function listStoredCredentials(): Array<{ account: string; password: string }> {
  const store = getSecureStore();
  const values = store.get('values');
  const credentials: Array<{ account: string; password: string }> = [];

  for (const key of Object.keys(values)) {
    const decrypted = decryptValue(values[key]);
    if (decrypted) {
      credentials.push({
        account: key,
        password: decrypted,
      });
    }
  }

  return credentials;
}

/**
 * Clear all secure storage (used during fresh install cleanup)
 */
export function clearSecureStorage(): void {
  const store = getSecureStore();
  store.clear();
  _derivedKey = null; // Clear cached key
}
