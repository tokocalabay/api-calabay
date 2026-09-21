/**
 * API Key Management Module
 * Handles generation, validation, revocation, and rate limiting of API keys.
 * 100% Persisted to MongoDB Atlas.
 */
const dns = require("dns");
try { dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]); } catch (_) {}

const crypto = require("crypto");
const mongoose = require("mongoose");
const { ApiKey } = require("./models");
const config = require("../config");

// ── In-memory cache for ultra-fast validation ────────────────
const keyCache = new Map();     // key → { userId, label, isActive, createdAt, lastUsed, totalRequests }
const rateLimits = new Map();   // key → { count, resetAt }

const MAX_KEYS_PER_USER = 1;
const RATE_LIMIT_WINDOW = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 60;         // 60 requests per window

function isMongoReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function ensureMongo() {
  if (isMongoReady()) return true;
  try {
    try { dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]); } catch (_) {}
    if (!config.MONGO_URI) {
      console.error("❌ [API Keys] MONGO_URI tidak ditemukan di config!");
      return false;
    }
    await mongoose.connect(config.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ [API Keys] Terhubung ke database MongoDB Atlas!");
    return true;
  } catch (err) {
    console.error("❌ [API Keys] Gagal koneksi ke MongoDB Atlas:", err.message);
    return false;
  }
}

// ── Initialize: Load keys from MongoDB ──────────────────────
async function init() {
  const ready = await ensureMongo();
  if (!ready) {
    console.error("⚠️ [API Keys] MongoDB belum siap saat init()");
    return false;
  }
  try {
    const keys = await ApiKey.find({ isActive: true }).lean();
    keyCache.clear();
    for (const k of keys) {
      keyCache.set(k.key, {
        userId: String(k.userId),
        label: k.label || "default",
        isActive: true,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
        totalRequests: k.totalRequests || 0,
      });
    }
    console.log(`✅ [API Keys] Loaded ${keys.length} active API keys dari MongoDB Atlas.`);
    return true;
  } catch (err) {
    console.error("⚠️ [API Keys] Failed to load from MongoDB:", err.message);
    return false;
  }
}

// ── Get or auto-create single active API key for user ───────
async function getOrCreateApiKey(userId) {
  const uid = String(userId);
  await ensureMongo();

  // 1. Cek apakah ada key aktif di MongoDB
  if (isMongoReady()) {
    try {
      const existing = await ApiKey.findOne({ userId: uid, isActive: true }).sort({ createdAt: -1 }).lean();
      if (existing) {
        keyCache.set(existing.key, {
          userId: uid,
          label: existing.label || "default",
          isActive: true,
          createdAt: existing.createdAt,
          lastUsed: existing.lastUsed,
          totalRequests: existing.totalRequests || 0,
        });
        return {
          success: true,
          key: existing.key,
          label: existing.label || "default",
          isActive: true,
          isNew: false,
          createdAt: existing.createdAt,
          lastUsed: existing.lastUsed,
          totalRequests: existing.totalRequests || 0,
        };
      }
    } catch (err) {
      console.error("⚠️ [API Keys] Error finding active key in MongoDB:", err.message);
    }
  } else {
    // In-memory cache fallback
    for (const [k, v] of keyCache) {
      if (v.userId === uid && v.isActive) {
        return {
          success: true,
          key: k,
          label: v.label || "default",
          isActive: true,
          isNew: false,
          createdAt: v.createdAt,
          lastUsed: v.lastUsed,
          totalRequests: v.totalRequests || 0,
        };
      }
    }
  }

  // 2. Jika belum ada key aktif sama sekali, langsung buatkan 1 key baru
  return await generateApiKey(uid, "default", true);
}

// ── Generate / Reset API key (Guarantees exactly 1 active key) ────────────
async function generateApiKey(userId, label = "default", forceReplace = true) {
  const uid = String(userId);

  // Pastikan MongoDB terhubung
  const connected = await ensureMongo();
  if (!connected) {
    return { 
      success: false, 
      error: "Database MongoDB sedang tidak terhubung. Silakan coba beberapa saat lagi." 
    };
  }

  // Nonaktifkan semua key lama milik user ini (1 user = 1 key)
  try {
    await ApiKey.updateMany({ userId: uid, isActive: true }, { isActive: false });
    for (const [k, v] of keyCache) {
      if (v.userId === uid) {
        keyCache.delete(k);
        rateLimits.delete(k);
      }
    }
  } catch (err) {
    console.error("⚠️ [API Keys] Error deactivating old keys in MongoDB:", err.message);
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

  // Simpan LANGSUNG ke MongoDB Atlas
  try {
    await ApiKey.create(entry);
    console.log(`✅ [API Keys] Sukses simpan 1 API Key ke MongoDB untuk user: ${uid}`);
  } catch (err) {
    console.error("❌ [API Keys] Gagal simpan key ke MongoDB Atlas:", err.message);
    return { success: false, error: "Gagal menyimpan API Key ke database MongoDB. Silakan coba lagi." };
  }

  // Simpan ke in-memory cache untuk performa
  keyCache.set(key, {
    userId: uid,
    label: entry.label,
    isActive: true,
    createdAt: now,
    lastUsed: null,
    totalRequests: 0,
  });

  return {
    success: true,
    key,
    label: entry.label,
    isActive: true,
    isNew: true,
    createdAt: now,
    lastUsed: null,
    totalRequests: 0,
  };
}

// ── Regenerate / Reset API key ──────────────────────────────
async function regenerateApiKey(userId) {
  return await generateApiKey(userId, "default", true);
}

// ── Validate API key ────────────────────────────────────────
async function validateApiKey(key) {
  if (!key || typeof key !== "string") return null;

  // 1. Cek cache in-memory
  const cached = keyCache.get(key);
  if (cached && cached.isActive) {
    return { ...cached };
  }

  // 2. Jika tidak ada di cache (misal cold start / baru restart), ambil langsung dari MongoDB!
  if (await ensureMongo()) {
    try {
      const doc = await ApiKey.findOne({ key, isActive: true }).lean();
      if (doc) {
        const data = {
          userId: String(doc.userId),
          label: doc.label || "default",
          isActive: true,
          createdAt: doc.createdAt,
          lastUsed: doc.lastUsed,
          totalRequests: doc.totalRequests || 0,
        };
        keyCache.set(key, data);
        return data;
      }
    } catch (err) {
      console.error("⚠️ [API Keys] validateApiKey DB error:", err.message);
    }
  }

  return null;
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
  const now = new Date().toISOString();
  if (cached) {
    cached.lastUsed = now;
    cached.totalRequests = (cached.totalRequests || 0) + 1;
  }

  // Async update MongoDB Atlas
  if (isMongoReady()) {
    ApiKey.updateOne(
      { key },
      { lastUsed: now, $inc: { totalRequests: 1 } }
    ).catch((err) => console.error("⚠️ [API Keys] recordUsage update error:", err.message));
  }
}

// ── List all keys for a user (Always from MongoDB Atlas) ─────
async function listApiKeys(userId) {
  const uid = String(userId);

  if (await ensureMongo()) {
    try {
      const keys = await ApiKey.find({ userId: uid }).sort({ createdAt: -1 }).lean();
      // Sync to cache
      for (const k of keys) {
        if (k.isActive) {
          keyCache.set(k.key, {
            userId: uid,
            label: k.label || "default",
            isActive: true,
            createdAt: k.createdAt,
            lastUsed: k.lastUsed,
            totalRequests: k.totalRequests || 0,
          });
        }
      }
      return keys.map((k) => ({
        key: k.key,
        label: k.label || "default",
        isActive: k.isActive !== false,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
        totalRequests: k.totalRequests || 0,
      }));
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to list keys from MongoDB:", err.message);
    }
  }

  // Fallback ke cache jika MongoDB benar-benar offline
  const results = [];
  for (const [key, data] of keyCache) {
    if (data.userId === uid) {
      results.push({ key, ...data });
    }
  }
  return results;
}

// ── Revoke API key (Direct to MongoDB Atlas) ─────────────────
async function revokeApiKey(userId, key) {
  const uid = String(userId);

  keyCache.delete(key);
  rateLimits.delete(key);

  if (await ensureMongo()) {
    try {
      const res = await ApiKey.updateOne({ key, userId: uid }, { isActive: false });
      if (res.matchedCount === 0) {
        return { success: false, error: "API key tidak ditemukan atau bukan milik kamu." };
      }
      return { success: true };
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to revoke key in MongoDB:", err.message);
      return { success: false, error: "Gagal menghapus API key di database." };
    }
  }

  return { success: false, error: "Database MongoDB tidak terhubung." };
}

// ── Revoke all keys for a user (Direct to MongoDB Atlas) ─────
async function revokeAllApiKeys(userId) {
  const uid = String(userId);

  for (const [key, data] of keyCache) {
    if (data.userId === uid) {
      keyCache.delete(key);
      rateLimits.delete(key);
    }
  }

  if (await ensureMongo()) {
    try {
      const res = await ApiKey.updateMany({ userId: uid, isActive: true }, { isActive: false });
      return { success: true, count: res.modifiedCount || 0 };
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to revoke all keys in MongoDB:", err.message);
      return { success: false, error: "Gagal me-revoke key di database." };
    }
  }

  return { success: false, error: "Database MongoDB tidak terhubung." };
}

// ── Clean up inactive / revoked keys from MongoDB ───────────
async function cleanupRevokedKeys(userId) {
  const uid = String(userId);

  if (await ensureMongo()) {
    try {
      const res = await ApiKey.deleteMany({ userId: uid, isActive: false });
      return { success: true, count: res.deletedCount || 0 };
    } catch (err) {
      console.error("⚠️ [API Keys] Failed to cleanup revoked keys in MongoDB:", err.message);
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Database MongoDB tidak terhubung." };
}

// ── Mask key for display ────────────────────────────────────
function maskKey(key) {
  if (!key || key.length < 16) return "****";
  return key.slice(0, 12) + "..." + key.slice(-4);
}

module.exports = {
  init,
  ensureMongo,
  isMongoReady,
  getOrCreateApiKey,
  generateApiKey,
  regenerateApiKey,
  validateApiKey,
  checkRateLimit,
  recordUsage,
  listApiKeys,
  revokeApiKey,
  revokeAllApiKeys,
  cleanupRevokedKeys,
  maskKey,
  MAX_KEYS_PER_USER,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW,
};
