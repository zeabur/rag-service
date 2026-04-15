// Shared API key utilities used by server.ts and manage-keys.ts

import { createHash, randomBytes } from "crypto";

export const VALID_SCOPES = [
  "query",
  "learn", "report", "feedback",
  "admin",
] as const;

export type Scope = typeof VALID_SCOPES[number];

export const KEY_PREFIX_LENGTH = 12;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateRawKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `rak_${randomBytes(32).toString("hex")}`;
  return {
    rawKey,
    keyHash: hashKey(rawKey),
    keyPrefix: rawKey.slice(0, KEY_PREFIX_LENGTH),
  };
}

export function validateScopes(scopes: string[]): string | null {
  for (const s of scopes) {
    if (!(VALID_SCOPES as readonly string[]).includes(s)) {
      return `Invalid scope: ${s}. Valid: ${VALID_SCOPES.join(", ")}`;
    }
  }
  return null;
}

export function computeExpiry(expiresDays?: number | null): string | null {
  if (expiresDays == null) return null;
  return new Date(Date.now() + expiresDays * 86400000).toISOString();
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];
  client: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function getKeyStatus(row: { revoked_at?: string | null; expires_at?: string | null }): "active" | "expired" | "revoked" {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at) < new Date()) return "expired";
  return "active";
}
