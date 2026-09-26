const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const DB_FILE = path.join(__dirname, "sessions.json");
let recoveredAfterRestart = false;

// ── Check if MongoDB is connected ──────────────────────────
function isMongoReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

// ── Get Session model (lazy load to avoid circular deps) ────
let _SessionModel = null;
function getSessionModel() {
  if (_SessionModel) return _SessionModel;
  try {
    _SessionModel = mongoose.model("Session");
  } catch {
    // Model not registered yet, define inline
    const sessionSchema = new mongoose.Schema({
      userId:     { type: String, required: true, index: true },
      sessionKey: { type: String, default: "" },
      data:       { type: mongoose.Schema.Types.Mixed, default: {} },
    }, { timestamps: true });
    _SessionModel = mongoose.model("Session", sessionSchema);
  }
  return _SessionModel;
}

// ── In-memory cache ─────────────────────────────────────────
let _sessionsCache = null;

function ensureCache() {
  if (_sessionsCache !== null) return _sessionsCache;
  _sessionsCache = readDatabaseFromFile();
  return _sessionsCache;
}

// ── Load sessions from MongoDB into memory cache ────────────
async function loadSessionsFromMongo() {
  if (!isMongoReady()) return;
  try {
    const Session = getSessionModel();
    const docs = await Session.find({}).lean();
    const data = {};
    for (const doc of docs) {
      const key = normalizeUserId(doc.userId);
      if (!data[key]) data[key] = [];
      data[key].push(doc.data || {});
    }
    _sessionsCache = data;
    console.log(`✅ [MongoDB] Sessions dimuat: ${docs.length} sesi aktif`);
  } catch (err) {
    console.error("⚠️ [MongoDB] Gagal load sessions:", err.message);
    _sessionsCache = readDatabaseFromFile();
  }
}

// ── File-based fallback ────────────────────────────────────
function readDatabaseFromFile() {
  if (!fs.existsSync(DB_FILE)) {
    recoveredAfterRestart = true;
    return {};
  }

  const raw = fs.readFileSync(DB_FILE, "utf8").trim();
  if (!raw) return {};

  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("sessions.json harus berisi object sesi.");
  }

  if (!recoveredAfterRestart) {
    let changed = false;
    for (const value of Object.values(parsed)) {
      const sessions = Array.isArray(value) ? value : [value];
      for (const session of sessions) {
        if (!session || typeof session !== "object") continue;
        if (session.retryProcessing) {
          session.retryProcessing = false;
          changed = true;
        }
        if (session.cancelProcessing) {
          session.cancelProcessing = false;
          changed = true;
        }
      }
    }
    recoveredAfterRestart = true;
    if (changed) writeDatabaseToFile(parsed);
  }

  return parsed;
}

function writeDatabaseToFile(data) {
  try {
    const tempFile = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error("⚠️ [Backup] Gagal tulis sessions.json:", err.message);
  }
}

function normalizeUserId(userId) {
  return String(userId);
}

// ══════════════════════════════════════════════════════════════
// PUBLIC API (same signatures as original)
// ══════════════════════════════════════════════════════════════

function get(userId) {
  const data = ensureCache();
  const value = data[normalizeUserId(userId)];
  if (Array.isArray(value)) {
    const active = value.find((item) =>
      item &&
      item.step === "tunggu_otp" &&
      ["waiting", "pending"].includes(String(item.status || "").toLowerCase())
    );
    if (active) return active;
    return value[value.length - 1] || null;
  }
  return value || null;
}

function getAll(userId) {
  const data = ensureCache();
  const value = data[normalizeUserId(userId)];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  return value && typeof value === "object" ? [value] : [];
}

function find(userId, sessionKey) {
  if (!sessionKey) return get(userId);
  return getAll(userId).find((item) =>
    String(item.sessionKey || item.trxId || item.orderId || "") === String(sessionKey)
  ) || null;
}

function set(userId, session) {
  if (!session || typeof session !== "object") {
    throw new TypeError("Sesi WAHUB harus berupa object.");
  }
  const data = ensureCache();
  const key = normalizeUserId(userId);
  const existing = getAll(userId);
  const sessionKey = String(session.sessionKey || session.trxId || session.orderId || "");
  const index = sessionKey
    ? existing.findIndex((item) =>
        String(item.sessionKey || item.trxId || item.orderId || "") === sessionKey
      )
    : -1;
  if (index >= 0) existing[index] = { ...session };
  else existing.push({ ...session });
  if (existing.length > 10) {
    existing.splice(0, existing.length - 10);
  }
  data[key] = existing;
  _sessionsCache = data;

  // Write backup to file
  writeDatabaseToFile(data);

  // Persist to MongoDB
  if (isMongoReady()) {
    const Session = getSessionModel();
    Session.findOneAndUpdate(
      { userId: key, sessionKey },
      { userId: key, sessionKey, data: { ...session } },
      { upsert: true, new: true }
    ).catch(err => console.error("⚠️ [MongoDB] session set error:", err.message));
  }

  return { ...session };
}

function remove(userId, sessionKey = null) {
  const data = ensureCache();
  const key = normalizeUserId(userId);
  if (!Object.prototype.hasOwnProperty.call(data, key)) return false;
  if (!sessionKey) {
    delete data[key];
  } else {
    const remaining = getAll(userId).filter((item) =>
      String(item.sessionKey || item.trxId || item.orderId || "") !== String(sessionKey)
    );
    if (remaining.length) data[key] = remaining;
    else delete data[key];
  }
  _sessionsCache = data;

  // Write backup to file
  writeDatabaseToFile(data);

  // Remove from MongoDB
  if (isMongoReady()) {
    const Session = getSessionModel();
    if (!sessionKey) {
      Session.deleteMany({ userId: key })
        .catch(err => console.error("⚠️ [MongoDB] session removeAll error:", err.message));
    } else {
      Session.deleteOne({ userId: key, sessionKey })
        .catch(err => console.error("⚠️ [MongoDB] session remove error:", err.message));
    }
  }

  return true;
}

function list() {
  const data = ensureCache();
  return Object.entries(data).flatMap(([userId]) =>
    getAll(userId).map((session) => ({ userId, session }))
  );
}

module.exports = {
  get,
  getAll,
  find,
  set,
  remove,
  list,
  loadSessionsFromMongo,
};