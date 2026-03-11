/**
 * Authentication and user types
 */

export interface User {
  id: string;
  email: string;
  name?: string;
  pictureUrl?: string;
  tier: 'free' | 'pro' | 'enterprise';
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  deviceId?: string;
  deviceName?: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ApiKeyConfig {
  id: string;
  provider: 'anthropic' | 'openai' | 'openrouter' | 'google' | 'xai' | 'deepseek' | 'zai' | 'custom' | 'bedrock';
  label?: string;
  keyPrefix?: string;
  isActive: boolean;
  lastUsedAt?: string;
  createdAt: string;
}

export interface BedrockAccessKeyCredentials {
  authType: 'accessKeys';
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;  // Optional: for temporary credentials (STS)
  region: string;
}

export interface BedrockProfileCredentials {
  authType: 'profile';
  profileName: string;
  region: string;
}

export type BedrockCredentials = BedrockAccessKeyCredentials | BedrockProfileCredentials;

export interface QuotaStatus {
  callsUsed: number;
  callsLimit: number;
  remaining: number;
  resetsAt?: string;
}
