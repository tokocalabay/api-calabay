/**
 * API Key Management Module
 * Handles generation, validation, revocation, and rate limiting of API keys.
 */
const crypto = require("crypto");
const { ApiKey } = require("./models");

// ── In-memory cache ─────────────────────────────────────────
const keyCache = new Map();     // key → { userId, label, isActive, createdAt, lastUsed, totalRequests }
const rateLimits = new Map();   // key → { count, resetAt }
let _mongoReady = false;

const MAX_KEYS_PER_USER = 3;
const RATE_LIMIT_WINDOW = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 60;         // 60 requests per window

// ── Initialize: Load keys from MongoDB ──────────────────────
async function init() {
  try {
    const keys = await ApiKey.find({ isActive: true }).lean();
    for (const k of keys) {
      keyCache.set(k.key, {
        userId: k.userId,
        label: k.label || "default",
        isActive: true,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
        totalRequests: k.totalRequests || 0,
      });
    }
    _mongoReady = true;
    console.log(`✅ [API Keys] Loaded ${keys.length} active API keys.`);
  } catch (err) {
    console.error("⚠️ [API Keys] Failed to load from MongoDB:", err.message);
  }
}

// ── Generate new API key ────────────────────────────────────
async function generateApiKey(userId, label = "default") {
  const uid = String(userId);

  // Check max keys limit
  const existingKeys = await listApiKeys(uid);
  const activeKeys = existingKeys.filter((k) => k.isActive);
  if (activeKeys.length >= MAX_KEYS_PER_USER) {
    return { success: false, error: `Maksimal ${MAX_KEYS_PER_USER} API key per user.` };
  }

  // Generate key: ck_live_ + 32 hex chars
  const key = `ck_live_${crypto.randomBytes(16).toString("hex")}`;
  const now = new Date().toISOString();

  const entry = {
    userId: uid,
    key,
    label: String(label).trim() || "default",
    isActive: true,
    createdAt: now,
    lastUsed: null,
    totalRequests: 0,
  };

  // Save to cache
  keyCache.set(key, {
    userId: uid,
    label: entry.label,
    isActive: true,
    createdAt: now,
    lastUsed: null,
    totalRequests: 0,
  });

  // Persist to MongoDB
  if (_mongoReady) {
    try {
      await ApiKey.create(entry);
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to save key:", err.message);
    }
  }

  return { success: true, key, label: entry.label, createdAt: now };
}

// ── Validate API key ────────────────────────────────────────
function validateApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const cached = keyCache.get(key);
  if (!cached || !cached.isActive) return null;
  return { ...cached };
}

// ── Rate limiting ───────────────────────────────────────────
function checkRateLimit(key) {
  const now = Date.now();
  let bucket = rateLimits.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimits.set(key, bucket);
  }

  bucket.count++;

  if (bucket.count > RATE_LIMIT_MAX) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: bucket.resetAt,
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX - bucket.count,
    resetAt: bucket.resetAt,
  };
}

// ── Record API key usage ────────────────────────────────────
function recordUsage(key) {
  const cached = keyCache.get(key);
  if (!cached) return;
  cached.lastUsed = new Date().toISOString();
  cached.totalRequests = (cached.totalRequests || 0) + 1;

  // Async update MongoDB (fire-and-forget)
  if (_mongoReady) {
    ApiKey.updateOne(
      { key },
      { lastUsed: cached.lastUsed, $inc: { totalRequests: 1 } }
    ).catch(() => {});
  }
}

// ── List all keys for a user ────────────────────────────────
async function listApiKeys(userId) {
  const uid = String(userId);
  if (_mongoReady) {
    try {
      const keys = await ApiKey.find({ userId: uid }).lean();
      return keys.map((k) => ({
        key: k.key,
        label: k.label || "default",
        isActive: k.isActive !== false,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
        totalRequests: k.totalRequests || 0,
      }));
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to list keys:", err.message);
    }
  }

  // Fallback: from cache
  const results = [];
  for (const [key, data] of keyCache) {
    if (data.userId === uid) {
      results.push({ key, ...data });
    }
  }
  return results;
}

// ── Revoke API key ──────────────────────────────────────────
async function revokeApiKey(userId, key) {
  const uid = String(userId);
  const cached = keyCache.get(key);
  if (!cached || cached.userId !== uid) {
    return { success: false, error: "API key tidak ditemukan atau bukan milik kamu." };
  }

  cached.isActive = false;
  keyCache.delete(key);
  rateLimits.delete(key);

  if (_mongoReady) {
    try {
      await ApiKey.updateOne({ key, userId: uid }, { isActive: false });
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to revoke key:", err.message);
    }
  }

  return { success: true };
}

// ── Revoke all keys for a user ──────────────────────────────
async function revokeAllApiKeys(userId) {
  const uid = String(userId);
  let count = 0;
  for (const [key, data] of keyCache) {
    if (data.userId === uid) {
      keyCache.delete(key);
      rateLimits.delete(key);
      count++;
    }
  }

  if (_mongoReady) {
    try {
      await ApiKey.updateMany({ userId: uid, isActive: true }, { isActive: false });
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to revoke all keys:", err.message);
    }
  }

  return { success: true, count };
}

// ── Mask key for display ────────────────────────────────────
function maskKey(key) {
  if (!key || key.length < 16) return "****";
  return key.slice(0, 12) + "..." + key.slice(-4);
}

module.exports = {
  init,
  generateApiKey,
  validateApiKey,
  checkRateLimit,
  recordUsage,
  listApiKeys,
  revokeApiKey,
  revokeAllApiKeys,
  maskKey,
  MAX_KEYS_PER_USER,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW,
};
