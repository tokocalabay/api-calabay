const dns      = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
const fs       = require("fs");
const path     = require("path");
const mongoose = require("mongoose");
const { User, Transaction, Deposit, Setting, Profit } = require("./lib/models");

const DB       = path.join(__dirname, "db.json");
const PROFIT_DB = path.join(__dirname, "profit.json");

// ── In-memory cache (loaded from MongoDB on boot) ───────────
let _cache = null;
let _profitCache = null;
let _mongoReady = false;

function getCurrentMonth() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function isMongoReady() {
  return Boolean(_mongoReady || (mongoose.connection && mongoose.connection.readyState === 1));
}

// ══════════════════════════════════════════════════════════════
// KONEKSI MONGODB
// ══════════════════════════════════════════════════════════════
async function connectMongo(uri) {
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    _mongoReady = true;
    if (!_cache) await loadFromMongo();
    return true;
  }
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ [MongoDB] Terhubung ke database MongoDB Atlas!");
    _mongoReady = true;

    // Load data from MongoDB into memory cache
    await loadFromMongo();
    return true;
  } catch (err) {
    console.error("❌ [MongoDB] Gagal terhubung:", err.message);
    console.log("⚠️  [MongoDB] Fallback ke database lokal (db.json)...");
    _mongoReady = false;
    return false;
  }
}

async function loadFromMongo() {
  if (!_mongoReady) return;
  try {
    // Load users
    const users = await User.find({}).lean();
    const usersMap = {};
    for (const u of users) {
      usersMap[u.userId] = {
        username:         u.username || "",
        joinedAt:         u.joinedAt || new Date().toISOString(),
        trx:              u.trx || 0,
        coin:             u.coin || 0,
        referralCode:     u.referralCode || makeReferralCode(u.userId),
        referredBy:       u.referredBy || null,
        referralRewarded: u.referralRewarded || false,
        referralCount:    u.referralCount || 0,
        referralEarned:   u.referralEarned || 0,
        isReseller:       Boolean(u.isReseller),
        isManualReseller: Boolean(u.isManualReseller),
        resellerUnlockedAt: u.resellerUnlockedAt || null,
        monthlyTrx:       Number(u.monthlyTrx || 0),
        lastTrxMonth:     u.lastTrxMonth || getCurrentMonth(),
      };
    }

    // Load transactions
    const transactions = await Transaction.find({}).sort({ date: 1 }).lean();
    const txList = transactions.map(t => ({
      id: t.id, userId: t.userId, username: t.username,
      orderId: t.orderId, phone: t.phone, productName: t.productName,
      negara: t.negara, harga: t.harga, provider: t.provider,
      serviceId: t.serviceId, countryId: t.countryId, operatorId: t.operatorId,
      providerPrice: t.providerPrice, refunded: t.refunded,
      refundedAt: t.refundedAt, date: t.date,
    }));

    // Load deposits
    const deposits = await Deposit.find({}).sort({ date: 1 }).lean();
    const depList = deposits.map(d => ({
      id: d.id, userId: d.userId, username: d.username,
      nominal: d.nominal, idtransaksi: d.idtransaksi, fotoId: d.fotoId,
      paymentAmount: d.paymentAmount, fee: d.fee, chatId: d.chatId,
      msgId: d.msgId, status: d.status, type: d.type, date: d.date,
    }));

    // Load settings
    const settingsDoc = await Setting.findOne({ key: "main" }).lean();
    let settings;
    if (settingsDoc) {
      settings = {
        wahub: settingsDoc.wahub || { profit: { mode: "flat", value: 100 } },
        providers: settingsDoc.providers || {},
        profit: settingsDoc.profit || {},
        paymentFee: settingsDoc.paymentFee || { mode: "flat", value: 0 },
        maintenance: settingsDoc.maintenance || false,
        manualDeposit: settingsDoc.manualDeposit !== false,
        mandatoryJoin: settingsDoc.mandatoryJoin || { enabled: false, chats: [] },
        referral: settingsDoc.referral || { enabled: false, reward: 0, commissionPercent: 10 },
        reseller: settingsDoc.reseller || defaultSettings().reseller,
      };
    } else {
      settings = defaultSettings();
    }

    _cache = {
      users: usersMap,
      transactions: txList,
      deposits: depList,
      totalRevenue: settingsDoc?.totalRevenue || 0,
      settings,
    };
    normalize(_cache);

    // Load profit DB
    const profitDoc = await Profit.findOne({ key: "main" }).lean();
    if (profitDoc) {
      _profitCache = {
        version: profitDoc.version || 1,
        providers: profitDoc.providers || {},
        services: profitDoc.services || {},
      };
    } else {
      _profitCache = { version: 1, providers: {}, services: {} };
    }

    console.log(`✅ [MongoDB] Cache dimuat: ${users.length} users, ${transactions.length} transaksi, ${deposits.length} deposit`);
  } catch (err) {
    console.error("❌ [MongoDB] Gagal load cache dari MongoDB:", err.message);
  }
}

function defaultSettings() {
  return {
    wahub: { profit: { mode: "flat", value: 100 } },
    providers: { wahub: true, engineunicorn: true, otpcepat: true, fastbit: true, herosms: true, rumahotp: true },
    profit: {
      wahub: { mode: "flat", value: 100 },
      engineunicorn: { mode: "flat", value: 100 },
      otpcepat: { mode: "flat", value: 0 },
      fastbit: { mode: "flat", value: 500 },
      herosms: { mode: "flat", value: 500 },
      rumahotp: { mode: "flat", value: 500 },
    },
    paymentFee: { mode: "flat", value: 0 },
    maintenance: false,
    manualDeposit: true,
    mandatoryJoin: { enabled: false, chats: [] },
    referral: { enabled: false, reward: 0, commissionPercent: 10 },
    reseller: {
      enabled: true,
      threshold: 100,
      discountMode: "flat",
      discountValue: 200,
      monthlyReset: true,
      lastResetMonth: getCurrentMonth(),
    },
  };
}

// ══════════════════════════════════════════════════════════════
// LOAD / SAVE (Hybrid: Memory → MongoDB + Fallback JSON)
// ══════════════════════════════════════════════════════════════
function load() {
  if (_cache) return _cache;

  // Fallback: load from local JSON if MongoDB not ready yet
  if (!fs.existsSync(DB)) {
    const init = {
      users: {},
      transactions: [],
      deposits: [],
      totalRevenue: 0,
      settings: defaultSettings(),
    };
    fs.writeFileSync(DB, JSON.stringify(init, null, 2));
    _cache = init;
    return init;
  }
  const data = JSON.parse(fs.readFileSync(DB, "utf-8"));
  normalize(data);
  _cache = data;
  return data;
}

function save(d) {
  normalize(d);
  _cache = d;

  // Always write to local JSON as backup
  try {
    fs.writeFileSync(DB, JSON.stringify(d, null, 2));
  } catch (err) {
    console.error("⚠️ [Backup] Gagal tulis db.json:", err.message);
  }

  // Async persist to MongoDB (fire & forget — memory is source of truth)
  if (_mongoReady) {
    persistSettingsToMongo(d).catch(err =>
      console.error("⚠️ [MongoDB] Gagal persist settings:", err.message)
    );
  }
}

async function persistSettingsToMongo(d) {
  if (!_mongoReady) return;
  try {
    await Setting.findOneAndUpdate(
      { key: "main" },
      {
        key: "main",
        wahub: d.settings.wahub,
        providers: d.settings.providers,
        profit: d.settings.profit,
        paymentFee: d.settings.paymentFee,
        maintenance: d.settings.maintenance,
        manualDeposit: d.settings.manualDeposit,
        mandatoryJoin: d.settings.mandatoryJoin,
        referral: d.settings.referral,
        reseller: d.settings.reseller,
        totalRevenue: d.totalRevenue,
      },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    console.error("⚠️ [MongoDB] persistSettings error:", err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// NORMALIZE (unchanged logic from original)
// ══════════════════════════════════════════════════════════════
function normalize(data) {
  if (!data.users) data.users = {};
  if (!data.transactions) data.transactions = [];
  if (!data.deposits) data.deposits = [];
  if (!Number.isFinite(Number(data.totalRevenue))) data.totalRevenue = 0;
  if (!data.settings) data.settings = {};
  data.settings.wahub = {
    profit: normalizeRule(data.settings.wahub?.profit, 100),
  };

  if (!data.settings.providers) data.settings.providers = {};
  data.settings.providers = {
    wahub: data.settings.providers.wahub !== false,
    engineunicorn: data.settings.providers.engineunicorn !== false,
    otpcepat: data.settings.providers.otpcepat !== false,
    herosms: data.settings.providers.herosms !== false,
    rumahotp: data.settings.providers.rumahotp !== false,
    fastbit: data.settings.providers.fastbit !== false,
  };

  if (!data.settings.profit) data.settings.profit = {};
  data.settings.profit = {
    wahub: normalizeRule(data.settings.profit?.wahub ?? data.settings.wahub?.profit, 100),
    engineunicorn: normalizeRule(data.settings.profit?.engineunicorn, 100),
    otpcepat: normalizeRule(data.settings.profit?.otpcepat, 0),
    herosms: normalizeRule(data.settings.profit?.herosms, 500),
    rumahotp: normalizeRule(data.settings.profit?.rumahotp, 500),
    fastbit: normalizeRule(data.settings.profit?.fastbit, 500),
  };
  data.settings.paymentFee = normalizeRule(data.settings.paymentFee, 0);
  data.settings.maintenance = data.settings.maintenance === true;
  data.settings.manualDeposit = data.settings.manualDeposit !== false;
  data.settings.mandatoryJoin = {
    enabled: data.settings.mandatoryJoin?.enabled === true,
    chats: Array.isArray(data.settings.mandatoryJoin?.chats)
      ? data.settings.mandatoryJoin.chats
        .filter(chat => chat && (chat.id !== undefined || chat.username))
        .map(chat => ({
          id: chat.id !== undefined ? String(chat.id) : "",
          title: String(chat.title || chat.username || chat.link || "Channel/Grup"),
          link: String(chat.link || chat.username || ""),
          username: String(chat.username || ""),
        }))
      : [],
  };
  data.settings.referral = {
    enabled: data.settings.referral?.enabled !== false,
    reward: Number.isFinite(Number(data.settings.referral?.reward)) &&
      Number(data.settings.referral.reward) >= 0
      ? Number(data.settings.referral.reward)
      : 0,
    commissionPercent: Number.isFinite(Number(data.settings.referral?.commissionPercent)) &&
      Number(data.settings.referral.commissionPercent) >= 0
      ? Number(data.settings.referral.commissionPercent)
      : 10,
  };

  const currentMonth = getCurrentMonth();
  data.settings.reseller = {
    enabled: data.settings.reseller?.enabled !== false,
    threshold: Number.isFinite(Number(data.settings.reseller?.threshold)) && Number(data.settings.reseller.threshold) > 0
      ? Number(data.settings.reseller.threshold)
      : 100,
    discountMode: ["percent", "flat"].includes(data.settings.reseller?.discountMode)
      ? data.settings.reseller.discountMode
      : "flat",
    discountValue: Number.isFinite(Number(data.settings.reseller?.discountValue)) && Number(data.settings.reseller.discountValue) >= 0
      ? Number(data.settings.reseller.discountValue)
      : 200,
    monthlyReset: data.settings.reseller?.monthlyReset !== false,
    lastResetMonth: data.settings.reseller?.lastResetMonth || currentMonth,
  };

  for (const [userId, user] of Object.entries(data.users)) {
    if (!user.referralCode) user.referralCode = makeReferralCode(userId);
    if (!Number.isFinite(Number(user.referralCount))) user.referralCount = 0;
    if (!Number.isFinite(Number(user.referralEarned))) user.referralEarned = 0;
    if (typeof user.isReseller !== "boolean") user.isReseller = false;
    if (typeof user.isManualReseller !== "boolean") user.isManualReseller = false;
    if (!Number.isFinite(Number(user.monthlyTrx))) user.monthlyTrx = 0;
    if (!user.lastTrxMonth) user.lastTrxMonth = currentMonth;
  }
  return data;
}

// ══════════════════════════════════════════════════════════════
// PROFIT DB (Hybrid)
// ══════════════════════════════════════════════════════════════
function loadProfitDb() {
  if (_profitCache) return _profitCache;

  if (!fs.existsSync(PROFIT_DB)) {
    const initial = {
      version: 1,
      providers: {
        wahub: { mode: "flat", value: 100 },
        otpcepat: { mode: "flat", value: 0 },
        herosms: { mode: "flat", value: 500 },
        rumahotp: { mode: "flat", value: 500 },
        fastbit: { mode: "flat", value: 500 },
      },
      services: {},
    };
    fs.writeFileSync(PROFIT_DB, JSON.stringify(initial, null, 2));
    _profitCache = initial;
    return initial;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PROFIT_DB, "utf-8"));
  } catch {
    data = { version: 1, providers: {}, services: {} };
  }
  data.version = 1;
  data.providers = data.providers && typeof data.providers === "object" ? data.providers : {};
  data.services = data.services && typeof data.services === "object" ? data.services : {};
  _profitCache = data;
  return data;
}

function saveProfitDb(data) {
  _profitCache = data;
  try {
    fs.writeFileSync(PROFIT_DB, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("⚠️ [Backup] Gagal tulis profit.json:", err.message);
  }

  if (_mongoReady) {
    Profit.findOneAndUpdate(
      { key: "main" },
      { key: "main", version: data.version, providers: data.providers, services: data.services },
      { upsert: true }
    ).catch(err => console.error("⚠️ [MongoDB] persistProfit error:", err.message));
  }
}

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (unchanged)
// ══════════════════════════════════════════════════════════════
function makeReferralCode(userId) {
  const numericId = String(userId).replace(/\D/g, "");
  return `REF${(numericId || "0").toUpperCase()}`;
}

function normalizeRule(rule, fallbackValue = 0) {
  const mode = rule?.mode === "percent" ? "percent" : "flat";
  const value = Number(rule?.value ?? fallbackValue);
  return { mode, value: Number.isFinite(value) && value >= 0 ? value : 0 };
}

function normalizeProvider(provider) {
  const value = String(provider || "").toLowerCase().trim();
  if (["wahub", "server1", "server 1", "server_1", "srv1", "s1", "wa1", "wa 1", "1"].includes(value)) {
    return "wahub";
  }
  if (["engineunicorn", "ninjaotp", "ninjatop", "unicorn", "server2", "server 2", "server_2", "srv2", "s2", "wa2", "wa 2", "2"].includes(value)) {
    return "engineunicorn";
  }
  if (["otpcepat", "otp cepat", "otpcepat.org", "smscode", "smscode.gg", "smscodegg"].includes(value)) {
    return "otpcepat";
  }
  if (["fastbit", "fast-bit", "claudexis", "fastbit.co.id", "sms1", "sms 1", "server1sms", "server 1 sms", "s1sms"].includes(value)) {
    return "fastbit";
  }
  if (["herosms", "hero sms", "hero-sms", "hero"].includes(value)) {
    return "herosms";
  }
  if (["rumahotp", "rumah-otp", "rumah otp", "ro", "sms2", "sms 2", "server2sms", "server 2 sms", "s2sms", "flashcall", "flash_call", "herosms_flashcall", "fc"].includes(value)) {
    return "rumahotp";
  }
  return null;
}

function normalizeMode(mode) {
  const value = String(mode || "").toLowerCase().trim();
  if (["persen", "percent", "percentage", "%"].includes(value)) return "percent";
  if (["flat", "nominal", "rp"].includes(value)) return "flat";
  return null;
}

// ══════════════════════════════════════════════════════════════
// USERS (Memory + MongoDB sync)
// ══════════════════════════════════════════════════════════════
function registerUser(userId, username, referralCode = null) {
  const db = load();
  if (!db.users[userId]) {
    const inviter = referralCode ? findUserByReferralCodeInData(db, referralCode, userId) : null;
    db.users[userId] = {
      username,
      joinedAt: new Date().toISOString(),
      trx:  0,
      coin: 0,
      referralCode: makeReferralCode(userId),
      referredBy: inviter?.id || null,
      referralRewarded: false,
      referralCount: 0,
      referralEarned: 0,
      isReseller: false,
      isManualReseller: false,
      resellerUnlockedAt: null,
      monthlyTrx: 0,
      lastTrxMonth: getCurrentMonth(),
    };
    save(db);

    // Persist new user to MongoDB
    if (_mongoReady) {
      User.create({ userId: String(userId), ...db.users[userId] })
        .catch(err => console.error("⚠️ [MongoDB] registerUser error:", err.message));
    }

    return { isNew: true, referralInviterId: inviter?.id || null };
  }
  const user = db.users[userId];
  if (!user.referralCode) user.referralCode = makeReferralCode(userId);
  if (username && user.username !== username) user.username = username;
  save(db);

  if (_mongoReady) {
    User.updateOne({ userId: String(userId) }, { username: user.username, referralCode: user.referralCode })
      .catch(err => console.error("⚠️ [MongoDB] updateUser error:", err.message));
  }

  return { isNew: false, referralInviterId: user.referredBy || null };
}

function findUserByReferralCodeInData(data, referralCode, excludeId = null) {
  const wanted = String(referralCode || "").trim().toUpperCase();
  if (!wanted) return null;
  const entry = Object.entries(data.users).find(([id, user]) =>
    String(id) !== String(excludeId) &&
    String(user.referralCode || makeReferralCode(id)).toUpperCase() === wanted
  );
  return entry ? { id: entry[0], ...entry[1] } : null;
}

function getReferralCode(userId) {
  const db = load();
  const user = db.users[userId];
  if (!user) return null;
  if (!user.referralCode) {
    user.referralCode = makeReferralCode(userId);
    save(db);
  }
  return user.referralCode;
}

function getReferralSettings() {
  return { ...load().settings.referral };
}

function setReferralEnabled(enabled) {
  const db = load();
  db.settings.referral.enabled = Boolean(enabled);
  save(db);
  return db.settings.referral.enabled;
}

function setReferralReward(reward) {
  const numericReward = Number(reward);
  if (!Number.isFinite(numericReward) || numericReward < 0) return false;
  const db = load();
  db.settings.referral.reward = Math.floor(numericReward);
  save(db);
  return db.settings.referral.reward;
}

function setReferralCommissionPercent(percent) {
  const numericPercent = Number(percent);
  if (!Number.isFinite(numericPercent) || numericPercent < 0 || numericPercent > 100) return false;
  const db = load();
  db.settings.referral.commissionPercent = Math.floor(numericPercent);
  save(db);
  return db.settings.referral.commissionPercent;
}

function processReferralReward(userId) {
  const db = load();
  const settings = db.settings.referral;
  const user = db.users[userId];
  if (!settings.enabled || !user || user.referralRewarded || !user.referredBy) {
    return { rewarded: false, reason: "not-eligible" };
  }

  const inviter = db.users[String(user.referredBy)];
  const reward = Math.floor(Number(settings.reward) || 0);
  if (!inviter || reward <= 0) return { rewarded: false, reason: "not-configured" };

  inviter.coin = (inviter.coin || 0) + reward;
  inviter.referralCount = (inviter.referralCount || 0) + 1;
  inviter.referralEarned = (inviter.referralEarned || 0) + reward;
  user.referralRewarded = true;
  save(db);

  // Sync both users to MongoDB
  if (_mongoReady) {
    const inviterId = String(user.referredBy);
    User.updateOne({ userId: inviterId }, {
      $inc: { coin: reward, referralCount: 1, referralEarned: reward },
    }).catch(err => console.error("⚠️ [MongoDB] referral inviter error:", err.message));
    User.updateOne({ userId: String(userId) }, { referralRewarded: true })
      .catch(err => console.error("⚠️ [MongoDB] referral user error:", err.message));
  }

  return { rewarded: true, inviterId: String(user.referredBy), reward };
}

function processDepositReferralCommission(userId, depositAmount) {
  const db = load();
  const settings = db.settings.referral;
  const user = db.users[String(userId)];
  const amount = Number(depositAmount) || 0;
  if (!settings.enabled || !user || !user.referredBy || amount <= 0) {
    return { rewarded: false, reason: "not-eligible" };
  }

  const inviterId = String(user.referredBy);
  const inviter = db.users[inviterId];
  if (!inviter) {
    return { rewarded: false, reason: "inviter-not-found" };
  }

  const percent = Number.isFinite(Number(settings.commissionPercent)) ? Number(settings.commissionPercent) : 10;
  const commission = Math.floor(amount * percent / 100);
  if (commission <= 0) {
    return { rewarded: false, reason: "zero-commission" };
  }

  inviter.coin = (inviter.coin || 0) + commission;
  inviter.referralEarned = (inviter.referralEarned || 0) + commission;
  save(db);

  if (_mongoReady) {
    User.updateOne({ userId: inviterId }, {
      $inc: { coin: commission, referralEarned: commission },
    }).catch(err => console.error("⚠️ [MongoDB] depositCommission error:", err.message));
  }

  return {
    rewarded: true,
    inviterId,
    inviterUsername: inviter.username || "User",
    depositorUserId: String(userId),
    depositorUsername: user.username || "User",
    depositAmount: amount,
    commission,
    percent,
  };
}

function getTopReferrals(limit = 10) {
  const db = load();
  const list = Object.entries(db.users).map(([userId, user]) => {
    return {
      userId,
      username: user.username || `User ${String(userId).slice(0, 4)}...`,
      count: Number(user.referralCount || 0),
      earned: Number(user.referralEarned || 0),
    };
  });
  list.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.earned - a.earned;
  });
  return list.filter(item => item.count > 0 || item.earned > 0).slice(0, limit);
}

function getReferralStats(userId) {
  const user = getUser(userId);
  const settings = getReferralSettings();
  return {
    code: user?.referralCode || makeReferralCode(userId),
    count: Number(user?.referralCount || 0),
    earned: Number(user?.referralEarned || 0),
    commissionPercent: Number(settings.commissionPercent || 10),
  };
}

const getTotalUsers   = () => Object.keys(load().users).length;
const getTotalTrx     = () => load().transactions.length;
const getTotalRevenue = () => load().totalRevenue;

// ══════════════════════════════════════════════════════════════
// COIN (Memory + MongoDB atomic $inc)
// ══════════════════════════════════════════════════════════════
function getCoin(userId) {
  const db = load();
  const uid = String(userId || "");
  return Number(db.users[uid]?.coin || 0);
}

function addCoin(userId, jumlah) {
  const db = load();
  const uid = String(userId || "");
  if (!db.users[uid]) {
    registerUser(uid, uid);
  }
  const amt = Number(jumlah);
  if (!Number.isFinite(amt) || amt <= 0) return Number(db.users[uid]?.coin || 0);

  db.users[uid].coin = Number(db.users[uid].coin || 0) + amt;
  save(db);

  if (_mongoReady) {
    User.findOneAndUpdate(
      { userId: uid },
      { $inc: { coin: amt } },
      { upsert: true, returnDocument: 'after' }
    ).then((doc) => {
      if (doc && Number.isFinite(Number(doc.coin))) {
        db.users[uid].coin = Number(doc.coin);
      }
    }).catch(err => console.error("⚠️ [MongoDB] addCoin error:", err.message));
  }

  return db.users[uid].coin;
}

function deductCoin(userId, jumlah) {
  const db = load();
  const uid = String(userId || "");
  const user = db.users[uid];
  if (!user) return false;
  const amt = Number(jumlah);
  if (!Number.isFinite(amt) || amt <= 0) return Number(user.coin || 0);
  if (Number(user.coin || 0) < amt) return false;

  user.coin = Number(user.coin || 0) - amt;
  save(db);

  if (_mongoReady) {
    User.findOneAndUpdate(
      { userId: uid, coin: { $gte: amt } },
      { $inc: { coin: -amt } },
      { returnDocument: 'after' }
    ).then((doc) => {
      if (doc && Number.isFinite(Number(doc.coin))) {
        user.coin = Number(doc.coin);
      }
    }).catch(err => console.error("⚠️ [MongoDB] deductCoin error:", err.message));
  }

  return user.coin;
}

function resetAllBalances(excludeUserId = null) {
  const db = load();
  let count = 0;
  let totalReset = 0;
  for (const [uid, user] of Object.entries(db.users)) {
    if (excludeUserId && String(uid) === String(excludeUserId)) continue;
    if (user.coin > 0) {
      totalReset += user.coin;
      user.coin = 0;
      count++;
    }
  }
  save(db);

  if (_mongoReady) {
    const filter = excludeUserId
      ? { userId: { $ne: String(excludeUserId) }, coin: { $gt: 0 } }
      : { coin: { $gt: 0 } };
    User.updateMany(filter, { $set: { coin: 0 } })
      .catch(err => console.error("⚠️ [MongoDB] resetBalances error:", err.message));
  }

  return { count, totalReset };
}

async function syncUser(userId) {
  if (!userId) return null;
  const uid = String(userId);
  if (isMongoReady()) {
    try {
      const u = await User.findOne({ userId: uid }).lean();
      if (u) {
        const d = load();
        d.users[uid] = {
          ...(d.users[uid] || {}),
          username: u.username || d.users[uid]?.username || "",
          joinedAt: u.joinedAt || d.users[uid]?.joinedAt || new Date().toISOString(),
          coin: Number(u.coin || 0),
          trx: Number(u.trx || 0),
          isReseller: Boolean(u.isReseller),
          isManualReseller: Boolean(u.isManualReseller),
          resellerUnlockedAt: u.resellerUnlockedAt || d.users[uid]?.resellerUnlockedAt || null,
          monthlyTrx: Number(u.monthlyTrx || 0),
          lastTrxMonth: u.lastTrxMonth || getCurrentMonth(),
          referralCode: u.referralCode || d.users[uid]?.referralCode || makeReferralCode(uid),
          referredBy: u.referredBy || d.users[uid]?.referredBy || null,
          referralCount: Number(u.referralCount || 0),
          referralEarned: Number(u.referralEarned || 0),
        };
        return d.users[uid];
      }
    } catch (err) {
      console.error("⚠️ [MongoDB] syncUser error:", err.message);
    }
  }
  return getUser(uid);
}

async function persistUser(userId) {
  if (!userId || !isMongoReady()) return false;
  const uid = String(userId);
  const u = getUser(uid);
  if (!u) return false;
  try {
    await User.updateOne(
      { userId: uid },
      {
        $set: {
          username: u.username || "",
          coin: Number(u.coin || 0),
          trx: Number(u.trx || 0),
          isReseller: Boolean(u.isReseller),
          isManualReseller: Boolean(u.isManualReseller),
          resellerUnlockedAt: u.resellerUnlockedAt || null,
          monthlyTrx: Number(u.monthlyTrx || 0),
          lastTrxMonth: u.lastTrxMonth || getCurrentMonth(),
        },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error("⚠️ [MongoDB] persistUser error:", err.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// DEPOSIT (Memory + MongoDB)
// ══════════════════════════════════════════════════════════════
function addDeposit({ userId, username, nominal, fotoId }) {
  const db = load();
  const id = `DEP-${Date.now()}`;
  const dep = {
    id, userId, username, nominal, fotoId,
    status: "pending",
    type:   "manual",
    date:   new Date().toISOString(),
  };
  db.deposits.push(dep);
  save(db);

  if (_mongoReady) {
    Deposit.create(dep)
      .catch(err => console.error("⚠️ [MongoDB] addDeposit error:", err.message));
  }

  return id;
}

function addDepositAuto({ depoId, userId, username, nominal, idtransaksi, status, paymentAmount, fee, chatId, msgId }) {
  const db = load();
  const dep = {
    id: depoId,
    userId, username, nominal, idtransaksi,
    paymentAmount: paymentAmount || nominal,
    fee: fee || 0,
    chatId: chatId || userId,
    msgId: msgId || null,
    status: status || "waiting_payment",
    type:   "auto_qris",
    date:   new Date().toISOString(),
  };
  db.deposits.push(dep);
  save(db);

  if (_mongoReady) {
    Deposit.create(dep)
      .catch(err => console.error("⚠️ [MongoDB] addDepositAuto error:", err.message));
  }

  return depoId;
}

function updateDeposit(depId, status) {
  const db  = load();
  const dep = db.deposits.find(d => d.id === depId);
  if (dep) {
    dep.status = status;
    save(db);

    if (_mongoReady) {
      Deposit.updateOne({ id: depId }, { status })
        .catch(err => console.error("⚠️ [MongoDB] updateDeposit error:", err.message));
    }
  }
}

function getDeposit(depId) {
  return load().deposits.find(d => d.id === depId) || null;
}

// ══════════════════════════════════════════════════════════════
// TRANSACTIONS (Memory + MongoDB)
// ══════════════════════════════════════════════════════════════
function addTransaction({
  userId, username, orderId, phone, productName, negara, harga,
  provider, serviceId, countryId, operatorId, providerPrice,
}) {
  const db = load();
  const id = `TRX-${Date.now()}`;
  const trx = {
    id, userId, username, orderId, phone,
    productName, negara, harga,
    provider: normalizeProvider(provider) || String(provider || ""),
    serviceId: serviceId !== undefined ? String(serviceId) : "",
    countryId: countryId !== undefined ? String(countryId) : "",
    operatorId: operatorId !== undefined ? String(operatorId) : "",
    providerPrice: Number.isFinite(Number(providerPrice)) ? Number(providerPrice) : null,
    date: new Date().toISOString(),
  };
  db.transactions.push(trx);
  db.totalRevenue += Number(harga);
  const uid = String(userId);
  if (db.users[uid]) {
    checkUserMonth(uid);
    db.users[uid].trx += 1;
    db.users[uid].monthlyTrx = (db.users[uid].monthlyTrx || 0) + 1;
    checkAndPromoteReseller(uid);
  }
  save(db);

  if (_mongoReady) {
    Transaction.create(trx)
      .catch(err => console.error("⚠️ [MongoDB] addTransaction error:", err.message));
    User.updateOne({ userId: uid }, { $inc: { trx: 1, monthlyTrx: 1 } })
      .catch(err => console.error("⚠️ [MongoDB] trxCount error:", err.message));
    Setting.updateOne({ key: "main" }, { $inc: { totalRevenue: Number(harga) } })
      .catch(err => console.error("⚠️ [MongoDB] revenue error:", err.message));
  }

  return id;
}

function getRiwayat(userId, limit = 5) {
  return load().transactions
    .filter(t => String(t.userId) === String(userId))
    .slice(-limit)
    .reverse();
}

function getTopBuyers(limit = 10) {
  const db = load();
  const map = {};

  // 1. Agregasi dari transaksi yang valid dan tidak di-refund
  for (const t of (db.transactions || [])) {
    if (!t || !t.userId || String(t.userId) === "undefined" || String(t.userId) === "null") continue;
    if (t.refunded === true || t.refunded === "true" || t.refunded === 1) continue;
    const uid = String(t.userId);
    if (!map[uid]) {
      const u = db.users[uid];
      map[uid] = {
        userId: uid,
        username: u?.username || t.username || `User ${uid.slice(0, 4)}...`,
        orderCount: 0,
        totalBelanja: 0,
        coin: Number(u?.coin || 0),
        jumlah: 0,
        total: 0,
        trx: 0,
      };
    }
    const harga = Math.max(0, Number(t.harga) || 0);
    map[uid].orderCount += 1;
    map[uid].jumlah += 1;
    map[uid].trx += 1;
    map[uid].totalBelanja += harga;
    map[uid].total += harga;
  }

  // 2. Gabungkan user yang memiliki transaksi di data user dan perbarui username
  for (const [uid, u] of Object.entries(db.users || {})) {
    if (!map[uid] && (u.trx > 0)) {
      map[uid] = {
        userId: uid,
        username: u.username || `User ${uid.slice(0, 4)}...`,
        orderCount: Number(u.trx || 0),
        jumlah: Number(u.trx || 0),
        trx: Number(u.trx || 0),
        totalBelanja: 0,
        total: 0,
        coin: Number(u.coin || 0),
      };
    } else if (map[uid] && u.username) {
      map[uid].username = u.username;
    }
  }

  const list = Object.values(map);
  // Urutkan berdasarkan jumlah orderan terbanyak (sesuai data riil bot)
  list.sort((a, b) => {
    if (b.orderCount !== a.orderCount) {
      return b.orderCount - a.orderCount;
    }
    return b.totalBelanja - a.totalBelanja;
  });

  return list.slice(0, limit);
}

function getUser(userId) {
  if (!userId) return null;
  checkUserMonth(userId);
  return load().users[String(userId)] || null;
}

function getUsers() {
  const db = load();
  return Object.entries(db.users).map(([id]) => {
    checkUserMonth(id);
    return { id, ...db.users[id] };
  });
}

function findUserByUsername(username) {
  const wanted = String(username || "").replace(/^@/, "").toLowerCase();
  return getUsers().find(user => String(user.username || "").toLowerCase() === wanted) || null;
}

function getTrxById(trxId) {
  return load().transactions.find(t => t.id === trxId) || null;
}

function getLastTransaction(userId) {
  return load().transactions
    .filter(t => String(t.userId) === String(userId))
    .slice(-1)[0] || null;
}


// ══════════════════════════════════════════════════════════════
// PROFIT REPORT (HARIAN / MINGGUAN / BULANAN / ALL)
// ══════════════════════════════════════════════════════════════
function getProfitReport(period = "today") {
  const db = load();
  const txs = db.transactions || [];
  const now = new Date();
  const jktFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayStr = jktFormatter.format(now);
  const startOfDay = new Date(todayStr + "T00:00:00+07:00").getTime();
  const startOfWeek = startOfDay - (6 * 24 * 60 * 60 * 1000);
  const [year, month] = todayStr.split("-");
  const startOfMonth = new Date(year + "-" + month + "-01T00:00:00+07:00").getTime();

  let startTime = 0;
  let periodLabel = "Semua Waktu";
  const p = String(period || "").toLowerCase();

  if (p === "today" || p === "harian" || p === "hari" || p === "1d") {
    startTime = startOfDay;
    periodLabel = "Hari Ini (" + todayStr + ")";
  } else if (p === "week" || p === "mingguan" || p === "minggu" || p === "7d") {
    startTime = startOfWeek;
    periodLabel = "Mingguan (7 Hari Terakhir)";
  } else if (p === "month" || p === "bulanan" || p === "bulan" || p === "30d") {
    startTime = startOfMonth;
    periodLabel = "Bulanan (" + year + "-" + month + ")";
  }

  let totalTrx = 0;
  let totalRefunded = 0;
  let totalOmset = 0;
  let totalModal = 0;
  let totalProfit = 0;

  let regulerTrx = 0;
  let regulerOmset = 0;
  let regulerModal = 0;
  let regulerProfit = 0;

  let resellerTrx = 0;
  let resellerOmset = 0;
  let resellerModal = 0;
  let resellerProfit = 0;

  for (const t of txs) {
    if (!t) continue;
    const d = new Date(t.date || t.createdAt || 0);
    const tTime = d.getTime();

    if (startTime > 0 && tTime < startTime) continue;

    const isRefunded = Boolean(t.refunded === true || t.refunded === "true" || t.refunded === 1);
    if (isRefunded) {
      totalRefunded++;
      continue;
    }

    const harga = Number(t.harga) || 0;
    const modal = Number(t.providerPrice) || 0;
    const profit = Math.max(0, harga - modal);
    const uid = String(t.userId);
    const user = db.users[uid];
    const isReseller = Boolean(user && (user.isReseller || user.isManualReseller));

    totalTrx++;
    totalOmset += harga;
    totalModal += modal;
    totalProfit += profit;

    if (isReseller) {
      resellerTrx++;
      resellerOmset += harga;
      resellerModal += modal;
      resellerProfit += profit;
    } else {
      regulerTrx++;
      regulerOmset += harga;
      regulerModal += modal;
      regulerProfit += profit;
    }
  }

  return {
    period: p || "today",
    periodLabel,
    totalTrx,
    totalRefunded,
    totalOmset,
    totalModal,
    totalProfit,
    reguler: {
      trx: regulerTrx,
      omset: regulerOmset,
      modal: regulerModal,
      profit: regulerProfit,
    },
    reseller: {
      trx: resellerTrx,
      omset: resellerOmset,
      modal: resellerModal,
      profit: resellerProfit,
    },
  };
}

function getTransactions(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return load().transactions.slice(-safeLimit).reverse();
}

function markRefunded(trxId) {
  const db  = load();
  const trx = db.transactions.find(t => t.id === trxId);
  if (trx && !trx.refunded) {
    trx.refunded = true;
    const uid = String(trx.userId);
    const user = db.users[uid];
    if (user) {
      if ((user.monthlyTrx || 0) > 0) user.monthlyTrx -= 1;
      if ((user.trx || 0) > 0) user.trx -= 1;
    }
    save(db);

    if (_mongoReady) {
      Transaction.updateOne({ id: trxId }, { refunded: true })
        .catch(err => console.error("⚠️ [MongoDB] markRefunded error:", err.message));
      User.updateOne({ userId: uid, monthlyTrx: { $gt: 0 } }, { $inc: { monthlyTrx: -1 } })
        .catch(err => console.error("⚠️ [MongoDB] refundMonthlyTrx error:", err.message));
      User.updateOne({ userId: uid, trx: { $gt: 0 } }, { $inc: { trx: -1 } })
        .catch(err => console.error("⚠️ [MongoDB] refundTrxCount error:", err.message));
    }
  }
}

function refundTransaction(trxId, userId) {
  const db = load();
  const uid = String(userId || "");
  const trx = db.transactions.find(item => item.id === trxId);
  if (!trx) return { refunded: false, reason: "not-found", amount: 0 };
  if (String(trx.userId) !== uid) {
    return { refunded: false, reason: "user-mismatch", amount: 0 };
  }
  const amount = Number(trx.harga);
  if (!Number.isFinite(amount) || amount < 0) {
    return { refunded: false, reason: "invalid-amount", amount: 0 };
  }
  if (trx.refunded) {
    return { refunded: false, alreadyRefunded: true, reason: "already-refunded", amount };
  }
  const user = db.users[uid];
  if (!user) return { refunded: false, reason: "user-not-found", amount: 0 };

  trx.refunded = true;
  trx.refundedAt = new Date().toISOString();
  user.coin = Number(user.coin || 0) + amount;
  if ((user.monthlyTrx || 0) > 0) user.monthlyTrx -= 1;
  if ((user.trx || 0) > 0) user.trx -= 1;
  save(db);

  if (_mongoReady) {
    Transaction.updateOne({ id: trxId }, { refunded: true, refundedAt: trx.refundedAt })
      .catch(err => console.error("⚠️ [MongoDB] refundTrx error:", err.message));
    User.findOneAndUpdate(
      { userId: uid },
      {
        $inc: { coin: amount },
        $set: {
          monthlyTrx: Math.max(0, Number(user.monthlyTrx || 0)),
          trx: Math.max(0, Number(user.trx || 0)),
        },
      },
      { returnDocument: 'after' }
    ).then((doc) => {
      if (doc && Number.isFinite(Number(doc.coin))) {
        user.coin = Number(doc.coin);
      }
    }).catch(err => console.error("⚠️ [MongoDB] refundCoin error:", err.message));
  }

  return { refunded: true, amount, balance: user.coin };
}

// ══════════════════════════════════════════════════════════════
// PROVIDER STATUS, PROFIT, PAYMENT FEE (unchanged logic)
// ══════════════════════════════════════════════════════════════
function getProviderStatus(provider) {
  const name = normalizeProvider(provider);
  if (!name) return false;
  return load().settings.providers[name] !== false;
}

function setProviderStatus(provider, isOpen) {
  const db = load();
  const providerValue = String(provider || "").toLowerCase().trim();
  const names = providerValue === "all"
    ? ["wahub", "engineunicorn", "fastbit", "herosms", "rumahotp"]
    : [normalizeProvider(provider)].filter(Boolean);
  if (!names.length) return false;
  for (const name of names) db.settings.providers[name] = Boolean(isOpen);
  save(db);
  return true;
}

function getServerStatus() {
  const db = load();
  return {
    server1: db.settings.providers?.wahub !== false,
    server2: db.settings.providers?.engineunicorn !== false,
    smsServer1: db.settings.providers?.fastbit !== false,
    smsServer2: db.settings.providers?.rumahotp !== false,
  };
}

function setServerStatus(serverNum, isOpen) {
  const num = String(serverNum).toLowerCase();
  let target = null;
  if (num === "1" || num === "wa1") target = "wahub";
  else if (num === "2" || num === "wa2" || num === "ninjaotp" || num === "ninjatop") target = "engineunicorn";
  else if (num === "sms1" || num === "fastbit" || num === "claudexis") target = "fastbit";
  else if (num === "herosms") target = "herosms";
  else if (num === "sms2" || num === "rumahotp" || num === "flashcall" || num === "fc") target = "rumahotp";
  if (!target) return false;
  return setProviderStatus(target, isOpen);
}

function getProfit(provider, serviceId = null) {
  if (String(provider || "").toLowerCase().trim() === "wahub") {
    provider = "wahub";
  }
  const name = normalizeProvider(provider);
  if (!name) return { mode: "flat", value: 0 };
  const data = loadProfitDb();
  const serviceKey = serviceId === null || serviceId === undefined
    ? ""
    : `${name}:${String(serviceId)}`;
  const rule = serviceKey && data.services[serviceKey]
    ? data.services[serviceKey]
    : data.providers[name] || load().settings.profit[name];
  return normalizeRule(rule, 0);
}

function setProfit(provider, mode, value) {
  const normalizedMode = normalizeMode(mode);
  const numericValue = Number(value);
  const providerValue = String(provider || "").toLowerCase().trim();
  if (!normalizedMode || !Number.isFinite(numericValue) || numericValue < 0) return false;
  const names = providerValue === "all"
    ? ["wahub", "engineunicorn", "fastbit", "herosms", "rumahotp"]
    : [normalizeProvider(provider)].filter(Boolean);
  if (providerValue === "wahub") names.push("wahub");
  if (providerValue === "engineunicorn") names.push("engineunicorn");
  const uniqueNames = [...new Set(names)];
  if (!uniqueNames.length) return false;
  const db = load();
  for (const name of uniqueNames) {
    const rule = { mode: normalizedMode, value: numericValue };
    if (name === "wahub") db.settings.wahub.profit = rule;
    else db.settings.profit[name] = rule;
    const profitDb = loadProfitDb();
    profitDb.providers[name] = rule;
    saveProfitDb(profitDb);
  }
  save(db);
  return true;
}

function setServiceProfit(provider, serviceId, serviceName, value, mode = "flat") {
  const name = normalizeProvider(provider);
  const id = String(serviceId || "").trim();
  const numericValue = Number(value);
  const normalizedMode = normalizeMode(mode) || "flat";
  if (!name || !id || !Number.isFinite(numericValue) || numericValue < 0) return false;
  const data = loadProfitDb();
  data.services[`${name}:${id}`] = {
    mode: normalizedMode,
    value: normalizedMode === "percent" ? numericValue : Math.floor(numericValue),
    provider: name,
    serviceId: id,
    serviceName: String(serviceName || id),
    updatedAt: new Date().toISOString(),
  };
  saveProfitDb(data);
  return true;
}

// ══════════════════════════════════════════════════════════════
// RESELLER SYSTEM (Monthly Target + Cheaper Price)
// ══════════════════════════════════════════════════════════════
function checkUserMonth(userIdOrUser) {
  const db = load();
  const uid = typeof userIdOrUser === "object" && userIdOrUser !== null
    ? String(userIdOrUser.id || userIdOrUser.userId || "")
    : String(userIdOrUser);
  const user = (uid && db.users[uid]) || (typeof userIdOrUser === "object" ? userIdOrUser : null);
  if (!user) return null;
  const currentMonth = getCurrentMonth();
  const settings = db.settings.reseller || defaultSettings().reseller;

  if (settings.monthlyReset && user.lastTrxMonth && user.lastTrxMonth !== currentMonth) {
    user.monthlyTrx = 0;
    user.lastTrxMonth = currentMonth;
    if (!user.isManualReseller) {
      user.isReseller = false;
    }
    save(db);
    if (_mongoReady) {
      User.updateOne({ userId: uid }, {
        monthlyTrx: 0,
        lastTrxMonth: currentMonth,
        ...(!user.isManualReseller ? { isReseller: false } : {}),
      }).catch(err => console.error("⚠️ [MongoDB] checkUserMonth sync error:", err.message));
    }
  }
  return user;
}

function isReseller(userId) {
  if (!userId) return false;
  if (typeof userId === "boolean") return userId;
  const user = getUser(userId);
  if (!user) return false;
  const db = load();
  const settings = db.settings.reseller || defaultSettings().reseller;
  if (!settings.enabled) return false;
  if (user.isManualReseller) return true;
  if (user.isReseller) return true;
  const threshold = Number(settings.threshold) || 100;
  return Number(user.monthlyTrx || 0) >= threshold;
}

function checkAndPromoteReseller(userId) {
  const user = getUser(userId);
  if (!user) return { isReseller: false, newlyUnlocked: false, user: null };
  const db = load();
  const settings = db.settings.reseller || defaultSettings().reseller;
  if (!settings.enabled) return { isReseller: false, newlyUnlocked: false, user };

  if (user.isManualReseller) {
    return { isReseller: true, newlyUnlocked: false, user };
  }

  const threshold = Number(settings.threshold) || 100;
  const monthlyTrx = Number(user.monthlyTrx || 0);

  if (monthlyTrx >= threshold) {
    const wasReseller = user.isReseller === true;
    user.isReseller = true;
    if (!user.resellerUnlockedAt || !wasReseller) {
      user.resellerUnlockedAt = new Date().toISOString();
    }
    save(db);
    if (_mongoReady) {
      User.updateOne({ userId: String(userId) }, {
        isReseller: true,
        resellerUnlockedAt: user.resellerUnlockedAt,
      }).catch(err => console.error("⚠️ [MongoDB] promoteReseller error:", err.message));
    }
    return { isReseller: true, newlyUnlocked: !wasReseller, user };
  }

  return { isReseller: false, newlyUnlocked: false, user };
}

function getResellerSettings() {
  const s = load().settings.reseller;
  const currentMonth = getCurrentMonth();
  return {
    enabled: s?.enabled !== false,
    threshold: Number(s?.threshold) || 100,
    discountMode: s?.discountMode === "percent" ? "percent" : "flat",
    discountValue: Number(s?.discountValue) || 200,
    monthlyReset: s?.monthlyReset !== false,
    lastResetMonth: s?.lastResetMonth || currentMonth,
  };
}

function setResellerEnabled(enabled) {
  const db = load();
  if (!db.settings.reseller) db.settings.reseller = defaultSettings().reseller;
  db.settings.reseller.enabled = Boolean(enabled);
  save(db);
  return db.settings.reseller.enabled;
}

function setResellerThreshold(threshold) {
  const num = Math.floor(Number(threshold));
  if (!Number.isFinite(num) || num <= 0) return false;
  const db = load();
  if (!db.settings.reseller) db.settings.reseller = defaultSettings().reseller;
  db.settings.reseller.threshold = num;
  save(db);
  return num;
}

function setResellerDiscount(mode, value) {
  const normalizedMode = normalizeMode(mode);
  const num = Number(value);
  if (!normalizedMode || !Number.isFinite(num) || num < 0) return false;
  const db = load();
  if (!db.settings.reseller) db.settings.reseller = defaultSettings().reseller;
  db.settings.reseller.discountMode = normalizedMode;
  db.settings.reseller.discountValue = normalizedMode === "percent" ? Math.min(100, num) : Math.floor(num);
  save(db);
  return db.settings.reseller;
}

function setResellerMonthlyReset(enabled) {
  const db = load();
  if (!db.settings.reseller) db.settings.reseller = defaultSettings().reseller;
  db.settings.reseller.monthlyReset = Boolean(enabled);
  save(db);
  return db.settings.reseller.monthlyReset;
}

function setUserReseller(userId, isResellerFlag, isManual = true) {
  const db = load();
  const uid = String(userId);
  const user = db.users[uid];
  if (!user) return false;
  user.isReseller = Boolean(isResellerFlag);
  user.isManualReseller = Boolean(isResellerFlag && isManual);
  if (isResellerFlag && !user.resellerUnlockedAt) {
    user.resellerUnlockedAt = new Date().toISOString();
  }
  save(db);

  if (_mongoReady) {
    User.updateOne({ userId: uid }, {
      isReseller: user.isReseller,
      isManualReseller: user.isManualReseller,
      resellerUnlockedAt: user.resellerUnlockedAt,
    }).catch(err => console.error("⚠️ [MongoDB] setUserReseller error:", err.message));
  }
  return true;
}

function getResellers() {
  const db = load();
  const list = [];
  for (const [id, user] of Object.entries(db.users)) {
    if (isReseller(id)) {
      list.push({
        id,
        username: user.username || `User ${id}`,
        monthlyTrx: Number(user.monthlyTrx || 0),
        totalTrx: Number(user.trx || 0),
        coin: Number(user.coin || 0),
        isManual: Boolean(user.isManualReseller),
        isManualReseller: Boolean(user.isManualReseller),
        unlockedAt: user.resellerUnlockedAt,
      });
    }
  }
  list.sort((a, b) => b.monthlyTrx - a.monthlyTrx);
  return list;
}

function resetMonthlyReseller(targetMonth = null) {
  const db = load();
  const currentMonth = targetMonth || getCurrentMonth();
  let count = 0;
  for (const [uid, user] of Object.entries(db.users)) {
    user.monthlyTrx = 0;
    user.lastTrxMonth = currentMonth;
    if (!user.isManualReseller) {
      user.isReseller = false;
    }
    count++;
  }
  if (!db.settings.reseller) db.settings.reseller = defaultSettings().reseller;
  db.settings.reseller.lastResetMonth = currentMonth;
  save(db);

  if (_mongoReady) {
    User.updateMany(
      { isManualReseller: { $ne: true } },
      { $set: { monthlyTrx: 0, lastTrxMonth: currentMonth, isReseller: false } }
    ).catch(err => console.error("⚠️ [MongoDB] resetMonthlyReseller error:", err.message));
    User.updateMany(
      { isManualReseller: true },
      { $set: { monthlyTrx: 0, lastTrxMonth: currentMonth } }
    ).catch(err => console.error("⚠️ [MongoDB] resetMonthlyReseller manual error:", err.message));
    Setting.updateOne({ key: "main" }, { "reseller.lastResetMonth": currentMonth })
      .catch(err => console.error("⚠️ [MongoDB] resetMonthSetting error:", err.message));
  }

  return { currentMonth, resetCount: count };
}

function calculatePrice(provider, basePrice, serviceId = null, userIdOrIsReseller = null) {
  const base = Number(basePrice) || 0;
  const rule = getProfit(provider, serviceId);
  const profit = rule.mode === "percent" ? base * rule.value / 100 : rule.value;
  const normalPrice = Math.max(0, Math.ceil(base + profit));

  if (userIdOrIsReseller && isReseller(userIdOrIsReseller)) {
    const settings = getResellerSettings();
    if (settings.enabled) {
      let discount = 0;
      if (settings.discountMode === "percent") {
        discount = Math.floor(normalPrice * (Number(settings.discountValue) || 0) / 100);
      } else {
        discount = Number(settings.discountValue) || 0;
      }
      // Proteksi harga modal provider: harga reseller tidak pernah di bawah modal
      return Math.max(base, Math.ceil(normalPrice - discount));
    }
  }

  return normalPrice;
}

function getResellerPriceDetails(provider, basePrice, serviceId = null, userId = null) {
  const base = Number(basePrice) || 0;
  const normalPrice = calculatePrice(provider, base, serviceId, false);
  const userIsReseller = Boolean(userId && isReseller(userId));
  const finalPrice = calculatePrice(provider, base, serviceId, userId);
  const discountAmount = Math.max(0, normalPrice - finalPrice);
  return {
    basePrice: base,
    normalPrice,
    finalPrice,
    discountAmount,
    isReseller: userIsReseller,
  };
}

function getPaymentFee() {
  return { ...load().settings.paymentFee };
}

function setPaymentFee(mode, value) {
  const normalizedMode = normalizeMode(mode);
  const numericValue = Number(value);
  if (!normalizedMode || !Number.isFinite(numericValue) || numericValue < 0) return false;
  const db = load();
  db.settings.paymentFee = { mode: normalizedMode, value: numericValue };
  save(db);
  return true;
}

function calculatePaymentFee(nominal) {
  const amount = Number(nominal) || 0;
  const rule = getPaymentFee();
  return Math.ceil(rule.mode === "percent" ? amount * rule.value / 100 : rule.value);
}

function calculatePaymentTotal(nominal) {
  const amount = Number(nominal) || 0;
  return amount + calculatePaymentFee(amount);
}

function getMaintenance() {
  return load().settings.maintenance === true;
}

function setMaintenance(enabled) {
  const db = load();
  db.settings.maintenance = Boolean(enabled);
  save(db);
  return db.settings.maintenance;
}

function getManualDeposit() {
  return load().settings.manualDeposit !== false;
}

function setManualDeposit(enabled) {
  const db = load();
  db.settings.manualDeposit = Boolean(enabled);
  save(db);
  return db.settings.manualDeposit;
}

// ══════════════════════════════════════════════════════════════
// MANDATORY JOIN (unchanged logic)
// ══════════════════════════════════════════════════════════════
function getMandatoryJoinSettings() {
  const settings = load().settings.mandatoryJoin;
  return {
    enabled: settings.enabled === true,
    chats: settings.chats.map(chat => ({ ...chat })),
  };
}

function setMandatoryJoinEnabled(enabled) {
  const db = load();
  db.settings.mandatoryJoin.enabled = Boolean(enabled);
  save(db);
  return db.settings.mandatoryJoin.enabled;
}

function addMandatoryJoin(chat) {
  const db = load();
  const normalizedId = String(chat.id || "");
  const exists = db.settings.mandatoryJoin.chats.some(item =>
    (normalizedId && String(item.id) === normalizedId) ||
    (chat.link && String(item.link).toLowerCase() === String(chat.link).toLowerCase())
  );
  if (exists) return false;
  db.settings.mandatoryJoin.chats.push({
    id: normalizedId,
    title: String(chat.title || chat.username || chat.link || "Channel/Grup"),
    link: String(chat.link || chat.username || ""),
    username: String(chat.username || ""),
  });
  save(db);
  return true;
}

function removeMandatoryJoin(identifier) {
  const db = load();
  const chats = db.settings.mandatoryJoin.chats;
  const raw = String(identifier || "").trim();
  const index = /^\d+$/.test(raw) ? Number(raw) - 1 : -1;
  const foundIndex = index >= 0 && index < chats.length
    ? index
    : chats.findIndex(chat =>
      String(chat.id) === raw ||
      String(chat.link).toLowerCase() === raw.toLowerCase() ||
      String(chat.username).toLowerCase() === raw.toLowerCase()
    );
  if (foundIndex < 0) return null;
  const [removed] = chats.splice(foundIndex, 1);
  save(db);
  return removed;
}

// ══════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════
module.exports = {
  load, save,
  connectMongo, isMongoReady, syncUser, persistUser,
  registerUser, getTotalUsers, getTotalTrx, getTotalRevenue, getUser,
  getUsers, findUserByUsername, getTransactions,
  getCoin, addCoin, deductCoin, resetAllBalances,
  addDeposit, addDepositAuto, updateDeposit, getDeposit,
  addTransaction, getRiwayat, getTopBuyers, getTrxById, getLastTransaction, markRefunded, refundTransaction,
  normalizeProvider,
  getProfitReport, getProviderStatus, setProviderStatus, getServerStatus, setServerStatus, getProfit, setProfit, setServiceProfit, calculatePrice,
  getResellerPriceDetails, isReseller, checkAndPromoteReseller, getResellerSettings, setResellerEnabled,
  setResellerThreshold, setResellerDiscount, setResellerMonthlyReset, setUserReseller, getResellers, resetMonthlyReseller, getCurrentMonth, checkUserMonth,
  getPaymentFee, setPaymentFee, calculatePaymentFee, calculatePaymentTotal,
  getMaintenance, setMaintenance,
  getManualDeposit, setManualDeposit,
  getReferralCode, getReferralSettings, setReferralEnabled, setReferralReward, setReferralCommissionPercent,
  processReferralReward, processDepositReferralCommission, getReferralStats, getTopReferrals,
  getMandatoryJoinSettings, setMandatoryJoinEnabled,
  addMandatoryJoin, removeMandatoryJoin,
};
