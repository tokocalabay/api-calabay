/**
 * Developer API Server — OTP Bot REST API
 *
 * Express router that provides REST endpoints for ordering OTP numbers,
 * checking status, cancelling orders, and managing balance.
 *
 * Mounted from index.js alongside the Telegram bot.
 */
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const config = require("./config");
const db = require("./db");
const wahub = require("./lib/wahub");
const engineunicorn = require("./lib/engineunicorn");
const herosms = require("./lib/herosms");
const rumahotp = require("./lib/rumahotp");
const fastbit = require("./lib/fastbit");
const apiKeys = require("./lib/api-keys");
const wahubSessionDb = require("./wahub-session-db");
const path = require("path");

const router = express.Router();

let apiCallbacks = {
  onOrderCreated: null,
  sendRealtimeOtp: null,
  sendOrderReport: null,
};

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sensorPhone(p) {
  const s = String(p || "").replace(/[^0-9+]/g, "");
  if (s.length < 8) return s;
  return s.slice(0, 5) + "XXXXX" + s.slice(-2);
}

function getWaktuJakarta() {
  const d = new Date();
  return d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB";
}

async function sendTelegramDirect(chatId, text) {
  if (!chatId || !config.BOT_TOKEN) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: text,
        parse_mode: "HTML",
      },
      { timeout: 8000 }
    );
  } catch (err) {
    console.error("⚠️ [Telegram Direct Error]:", err.response?.data?.description || err.message);
  }
}

async function sendChannelRealtimeOtp({ serviceName, phone, otp, trxId }) {
  if (typeof apiCallbacks.sendRealtimeOtp === "function") {
    try {
      await apiCallbacks.sendRealtimeOtp({ serviceName, phone, otp, trxId });
      return;
    } catch (e) {
      console.error("[sendRealtimeOtp callback error]:", e.message);
    }
  }

  const targetChannel = config.CHANNEL_NOTIF_REALTIME || config.CHANNEL_USERNAME;
  if (!targetChannel) return;

  const text = `<blockquote>🔔 <b>NOTIF REALTIME OTP MASUK!</b>
━━━━━━━━━━━━━━━━
🔧 Layanan : <b>${escapeHTML(serviceName || "Nokos")}</b>
📱 Nomor   : <code>${escapeHTML(sensorPhone(phone))}</code>
🔑 Kode OTP: <code>${escapeHTML(otp)}</code>
🧾 TRX ID  : <code>${escapeHTML(trxId || "-")}</code>
⏰ Waktu   : <i>${getWaktuJakarta()}</i>
━━━━━━━━━━━━━━━━
⚡ <i>Transaksi otomatis & realtime via ${config.API_DOCS_URL || "api.calabay.my.id"}</i></blockquote>`;

  await sendTelegramDirect(targetChannel, text);
}

async function sendChannelOrderReport({
  type = "WHATSAPP",
  username = "",
  userId = "",
  saldo = null,
  serviceName = "",
  phone = "",
  harga = 0,
  modal = 0,
  otp = "",
  serverName = "",
  isNewOrder = false,
}) {
  if (!isNewOrder && typeof apiCallbacks.sendOrderReport === "function") {
    try {
      await apiCallbacks.sendOrderReport({
        type,
        username,
        userId,
        saldo,
        serviceName,
        phone,
        harga,
        modal,
        otp,
        serverName,
      });
      return;
    } catch (e) {
      console.error("[sendOrderReport callback error]:", e.message);
    }
  }

  const targetChannel = config.CHANNEL_NOTIF_ORDER;
  if (!targetChannel) return;

  const userDisplay = username ? username.replace(/^@/, "") : (userId ? String(userId) : "User");
  const modalText = (modal !== undefined && modal !== null && Number(modal) > 0)
    ? ` (Modal: Rp ${Number(modal).toLocaleString("id-ID")})`
    : "";

  const userSaldo = (saldo !== null && saldo !== undefined)
    ? Number(saldo)
    : (userId ? Number(db.getCoin(userId) || 0) : 0);
  const saldoText = `\n💸 Sisa Saldo: <b>Rp ${userSaldo.toLocaleString("id-ID")}</b>`;

  const headerTitle = isNewOrder
    ? `🛒 <b>LAPORAN ORDER API MASUK (${String(type).toUpperCase()})</b>`
    : `💬 <b>LAPORAN ORDER OTP (${String(type).toUpperCase()})</b>`;

  const statusOrOtpText = isNewOrder
    ? `⏳ Status: <b>Menunggu OTP...</b>`
    : `🔐 Kode: <code>${escapeHTML(String(otp || "-"))}</code>`;

  const text = `<blockquote>${headerTitle}

👤 User: <b>${escapeHTML(userDisplay)}</b>
🆔 ID: <code>${escapeHTML(String(userId || "-"))}</code>${saldoText}
💬 Layanan: <b>${escapeHTML(serviceName || "-")}</b>
📞 Nomor: <code>${escapeHTML(String(phone || "-"))}</code>
💰 Harga: <b>Rp ${Number(harga || 0).toLocaleString("id-ID")}</b>${modalText}
${statusOrOtpText}
🖥️ Server: <b>${escapeHTML(serverName || "-")}</b>
🌐 Source: <b>API Web (api.calabay.my.id)</b></blockquote>`;

  await sendTelegramDirect(targetChannel, text);
}

// ══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════════════

// ── Auth middleware ──────────────────────────────────────────
async function authMiddleware(req, res, next) {
  let key = "";
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    key = authHeader.slice(7).trim();
  } else if (req.query?.api_key || req.query?.key) {
    key = String(req.query.api_key || req.query.key).trim();
  } else if (req.body?.api_key || req.body?.key) {
    key = String(req.body.api_key || req.body.key).trim();
  }

  if (!key) {
    return res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing API Key. Gunakan header 'Authorization: Bearer ck_live_xxx' atau parameter query/body 'api_key'.",
      },
    });
  }

  const keyData = await apiKeys.validateApiKey(key);
  if (!keyData) {
    return res.status(401).json({
      success: false,
      error: {
        code: "INVALID_API_KEY",
        message: "API key tidak valid atau sudah dinonaktifkan di bot Telegram.",
      },
    });
  }

  // Rate limiting
  const rateCheck = apiKeys.checkRateLimit(key);
  res.set("X-RateLimit-Limit", String(apiKeys.RATE_LIMIT_MAX));
  res.set("X-RateLimit-Remaining", String(rateCheck.remaining));
  res.set("X-RateLimit-Reset", String(Math.ceil(rateCheck.resetAt / 1000)));

  if (!rateCheck.allowed) {
    return res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: `Terlalu banyak request. Coba lagi dalam ${rateCheck.retryAfter} detik.`,
        retry_after: rateCheck.retryAfter,
      },
    });
  }

  // Record usage
  apiKeys.recordUsage(key);

  // Attach user info to request
  req.apiKey = key;
  req.apiUserId = String(keyData.userId);

  // Sync user data & coin from MongoDB so API balance always matches Telegram
  try {
    await db.syncUser(req.apiUserId);
  } catch (err) {
    console.error("⚠️ [API Server] syncUser error in authMiddleware:", err.message);
  }

  next();
}

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function normalizeProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (["server_1", "server1", "wa1", "whatsapp1", "wahub"].includes(p)) return "wahub";
  if (["server_2", "server2", "wa2", "whatsapp2", "engineunicorn", "ninjaotp", "ninjatop"].includes(p)) return "engineunicorn";
  if (["sms_1", "sms1", "sms_server1", "fastbit", "fast-bit", "claudexis"].includes(p)) return "fastbit";
  if (["sms_2", "sms2", "sms_server2", "herosms", "hero", "rumahotp", "rumah", "flashcall", "flash_call", "fc"].includes(p)) return "herosms";
  return p;
}

function getPublicProviderCode(internalProvider) {
  const map = {
    wahub: "server_1",
    engineunicorn: "server_2",
    fastbit: "sms_1",
    herosms: "sms_2",
    rumahotp: "sms_2",
  };
  return map[internalProvider] || internalProvider;
}

function getProviderLabel(provider) {
  const labels = {
    wahub: "Server 1 (WhatsApp)",
    engineunicorn: "Server 2 (WhatsApp)",
    fastbit: "Server 1 (SMS)",
    herosms: "Server 2 (SMS - FlashCall)",
    rumahotp: "Server 2 (SMS - FlashCall)",
    server_1: "Server 1 (WhatsApp)",
    server_2: "Server 2 (WhatsApp)",
    sms_1: "Server 1 (SMS)",
    sms_2: "Server 2 (SMS - FlashCall)",
    flashcall: "Server 2 (SMS - FlashCall)",
  };
  return labels[provider] || "Server 1";
}

// ══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════════════════════

// ── GET /api/v1/services ────────────────────────────────────
// List available OTP services
router.get("/services", authMiddleware, async (req, res) => {
  try {
    const rawP = req.query.provider || req.query.server || "";
    const provider = normalizeProvider(rawP);
    const result = { whatsapp: [], sms: [] };

    // WhatsApp providers
    if (!provider || provider === "wahub") {
      if (db.getProviderStatus("wahub") !== false) {
        try {
          const services = await wahub.getServices();
          result.whatsapp.push(
            ...services
              .filter((s) => s.id && s.name && s.stock > 0)
              .map((s) => ({
                service_id: String(s.id),
                name: s.name,
                price: db.calculatePrice("wahub", s.price, s.id, req.apiUserId),
                stock: s.stock,
                provider: "server_1",
                server: "server_1",
                server_label: "Server 1 (WhatsApp)",
                type: "whatsapp",
              }))
          );
        } catch (e) {}
      }
    }

    if (!provider || provider === "engineunicorn") {
      if (db.getProviderStatus("engineunicorn") !== false) {
        try {
          const services = await engineunicorn.getServices();
          result.whatsapp.push(
            ...services
              .filter((s) => s.id && s.name && Number(s.stock) > 0)
              .map((s) => ({
                service_id: String(s.id),
                name: s.name,
                price: db.calculatePrice("engineunicorn", s.price, s.id, req.apiUserId),
                stock: Number(s.stock) || 0,
                provider: "server_2",
                server: "server_2",
                server_label: "Server 2 (WhatsApp)",
                type: "whatsapp",
              }))
          );
        } catch (e) {}
      }
    }

    // SMS providers
    if (!provider || provider === "fastbit") {
      if (db.getProviderStatus("fastbit") !== false) {
        try {
          const services = await fastbit.getServices();
          result.sms.push(
            ...services
              .filter((s) => s.id && s.name)
              .map((s) => ({
                service_id: String(s.id),
                name: s.name,
                price: db.calculatePrice("fastbit", 0, s.id, req.apiUserId),
                stock: 0,
                provider: "sms_1",
                server: "sms_1",
                server_label: "Server 1 (SMS)",
                type: "sms",
              }))
          );
        } catch (e) {}
      }
    }

    if (!provider || provider === "herosms" || provider === "rumahotp") {
      if (db.getProviderStatus("rumahotp") !== false || db.getProviderStatus("herosms") !== false) {
        try {
          const services = await herosms.getServices();
          result.sms.push(
            ...services
              .filter((s) => s.id && s.name)
              .map((s) => ({
                service_id: String(s.id),
                name: `${s.name} (FlashCall + SMS)`,
                price: db.calculatePrice("rumahotp", s.price || 0, s.id, req.apiUserId),
                stock: Number(s.stock) || 0,
                provider: "sms_2",
                server: "sms_2",
                server_label: "Server 2 (SMS - FlashCall + SMS)",
                type: "flashcall",
                verification_type: "flashcall",
              }))
          );
        } catch (e) {}
      }
    }

    res.json({
      success: true,
      data: result,
      total: result.whatsapp.length + result.sms.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ── GET /api/v1/countries ───────────────────────────────────
// List countries and offers for a service
router.get("/countries", authMiddleware, async (req, res) => {
  try {
    const rawP = req.query.provider || req.query.server || "sms_1";
    const provider = normalizeProvider(rawP);
    const serviceId = req.query.service_id;
    if (!serviceId) {
      return res.status(400).json({
        success: false,
        error: { code: "MISSING_FIELD", message: "Parameter 'service_id' wajib diisi." },
      });
    }

    if (provider === "fastbit") {
      const countries = await fastbit.getCountriesForService(serviceId);
      return res.json({
        success: true,
        data: (countries || []).map((c) => ({
          country_id: c.iso,
          name: c.name,
          iso: c.iso,
          prefix: c.prefix,
          price: db.calculatePrice("fastbit", c.price, serviceId, req.apiUserId),
          stock: c.stock,
          offers: (c.offers || []).map((o) => ({
            otp_service_id: o.id,
            operator: o.operator,
            price: db.calculatePrice("fastbit", o.price, serviceId, req.apiUserId),
            stock: o.stock,
          })),
        })),
        total: (countries || []).length,
      });
    }

    if (provider === "herosms" || provider === "rumahotp") {
      const countries = await herosms.getCountries();
      return res.json({
        success: true,
        data: (countries || []).map((c) => ({
          country_id: String(c.id),
          name: c.name,
          iso: c.iso || c.code || "",
          prefix: c.prefix || "",
        })),
        total: (countries || []).length,
      });
    }

    return res.status(400).json({
      success: false,
      error: { code: "NOT_SUPPORTED", message: "Provider ini tidak mendukung pemilihan negara." },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ── GET & POST /api/v1/balance ──────────────────────────────
const handleBalance = async (req, res) => {
  try {
    const uid = req.apiUserId;
    await db.syncUser(uid);
    const coin = db.getCoin(uid);
    const user = db.getUser(uid);
    res.json({
      success: true,
      data: {
        user_id: uid,
        username: user?.username || "",
        balance: coin,
        balance_formatted: rupiah(coin),
        is_reseller: Boolean(user?.isReseller || user?.isManualReseller),
        total_trx: user?.trx || 0,
        synced_with_bot: true,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
};

router.get("/balance", authMiddleware, handleBalance);
router.post("/balance", authMiddleware, handleBalance);

// ── GET & POST /api/v1/check-key ────────────────────────────
// Cek validitas API Key, profil user Telegram, dan saldo real-time
const handleCheckKey = async (req, res) => {
  try {
    let key = "";
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      key = authHeader.slice(7).trim();
    } else if (req.query?.api_key || req.query?.key) {
      key = String(req.query.api_key || req.query.key).trim();
    } else if (req.body?.api_key || req.body?.key) {
      key = String(req.body.api_key || req.body.key).trim();
    }

    if (!key) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_API_KEY",
          message: "API Key wajib diisi via header 'Authorization: Bearer ck_live_xxx', parameter query '?api_key=xxx', atau body JSON '{ \"api_key\": \"xxx\" }'.",
        },
      });
    }

    const keyData = await apiKeys.validateApiKey(key);
    if (!keyData || !keyData.isActive) {
      return res.status(401).json({
        success: false,
        error: {
          code: "INVALID_API_KEY",
          message: "API Key tidak valid atau sudah dinonaktifkan di bot Telegram.",
        },
      });
    }

    const uid = String(keyData.userId);
    // Sinkronisasi data user & saldo live dari MongoDB Atlas
    await db.syncUser(uid);
    const user = db.getUser(uid);
    const coin = db.getCoin(uid);
    const rateCheck = apiKeys.checkRateLimit(key);

    res.json({
      success: true,
      data: {
        api_key: key,
        user_id: uid,
        username: user?.username || "",
        balance: coin,
        balance_formatted: rupiah(coin),
        is_reseller: Boolean(user?.isReseller || user?.isManualReseller),
        total_trx: Number(user?.trx || 0),
        status: "active",
        created_at: keyData.createdAt || null,
        last_used: keyData.lastUsed || null,
        total_requests: Number(keyData.totalRequests || 0),
        rate_limit: {
          limit: apiKeys.RATE_LIMIT_MAX,
          remaining: rateCheck.remaining,
          reset_in_seconds: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
        },
        synced_with_bot: true,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
};

router.get("/check-key", handleCheckKey);
router.post("/check-key", handleCheckKey);

// ── POST /api/v1/order ──────────────────────────────────────
// Order a new OTP number
router.post("/order", authMiddleware, async (req, res) => {
  try {
    const uid = req.apiUserId;
    const apiUser = db.getUser(uid);
    const apiUsername = apiUser?.username || "api_user";
    const { service_id, provider: rawProvider, server: rawServer, country_id, operator_id } = req.body || {};
    const chosenProvider = rawProvider || rawServer;

    if (!service_id) {
      return res.status(400).json({
        success: false,
        error: { code: "MISSING_FIELD", message: "Field 'service_id' wajib diisi." },
      });
    }
    if (!chosenProvider) {
      return res.status(400).json({
        success: false,
        error: { code: "MISSING_FIELD", message: "Field 'provider' atau 'server' wajib diisi. Pilihan: server_1, server_2, sms_1, sms_2." },
      });
    }

    const provider = normalizeProvider(chosenProvider);
    const validProviders = ["wahub", "engineunicorn", "fastbit", "herosms", "rumahotp"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_PROVIDER", message: `Pilihan server '${chosenProvider}' tidak valid. Pilihan: server_1, server_2, sms_1, sms_2.` },
      });
    }

    // Check provider is enabled
    if (db.getProviderStatus(provider) === false) {
      return res.status(503).json({
        success: false,
        error: { code: "PROVIDER_DISABLED", message: `Layanan ${getProviderLabel(provider)} sedang dinonaktifkan.` },
      });
    }

    // Check maintenance
    if (db.getMaintenance()) {
      return res.status(503).json({
        success: false,
        error: { code: "MAINTENANCE", message: "Bot sedang dalam mode maintenance. Coba lagi nanti." },
      });
    }

    let order, providerPrice, serviceName;

    // ── WhatsApp providers ──
    if (provider === "wahub") {
      const services = await wahub.getServices();
      const svc = services.find((s) => String(s.id) === String(service_id));
      if (!svc) {
        return res.status(404).json({
          success: false,
          error: { code: "SERVICE_NOT_FOUND", message: `Layanan dengan ID '${service_id}' tidak ditemukan di Server 1.` },
        });
      }
      providerPrice = svc.price;
      serviceName = svc.name;
      const price = db.calculatePrice("wahub", providerPrice, svc.id, uid);
      const coin = db.getCoin(uid);
      if (coin < price) {
        return res.status(402).json({
          success: false,
          error: {
            code: "INSUFFICIENT_BALANCE",
            message: `Coin tidak cukup. Harga: ${rupiah(price)}, Coin kamu: ${rupiah(coin)}.`,
            required: price,
            balance: coin,
          },
        });
      }
      const deducted = db.deductCoin(uid, price);
      if (deducted === false) {
        return res.status(500).json({
          success: false,
          error: { code: "DEDUCT_FAILED", message: "Gagal memotong saldo." },
        });
      }
      await db.persistUser(uid);
      order = await wahub.rent(svc.id);
      if (!order?.order_id || !order.token || !order.phone) {
        db.addCoin(uid, price);
        await db.persistUser(uid);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: wahub.getLastError() || "Gagal order nomor. Stok habis." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: apiUsername, orderId: order.order_id,
        phone: order.phone, productName: serviceName, negara: "Indonesia",
        harga: price, provider: "wahub", serviceId: svc.id, providerPrice,
      });

      // Create wahub session for polling
      const expiryMs = Date.now() + 20 * 60 * 1000;
      const newSess = {
        userId: uid,
        step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
        provider: "wahub", createdAt: new Date().toISOString(),
        serviceId: svc.id, serviceName, hargaUser: price, providerPrice,
        orderId: order.order_id, token: order.token, phone: order.phone,
        expiresAt: expiryMs, cancelAt: 0, retryCount: 0, trxId,
        sessionKey: trxId, source: "api",
      };
      wahubSessionDb.set(uid, newSess);
      if (typeof apiCallbacks.onOrderCreated === "function") {
        try { apiCallbacks.onOrderCreated(newSess); } catch (e) { console.error("[onOrderCreated error]:", e); }
      }

      sendChannelOrderReport({
        type: "WHATSAPP",
        username: apiUsername,
        userId: uid,
        saldo: db.getCoin(uid),
        serviceName,
        phone: order.phone,
        harga: price,
        modal: providerPrice,
        serverName: getProviderLabel("wahub"),
        isNewOrder: true,
      }).catch(() => {});

      return res.status(201).json({
        success: true,
        data: {
          order_id: trxId,
          phone: order.phone,
          service: serviceName,
          provider: "server_1",
          server: "server_1",
          server_label: "Server 1 (WhatsApp)",
          price,
          balance_after: db.getCoin(uid),
          expires_at: new Date(expiryMs).toISOString(),
          status: "waiting",
        },
      });
    }

    if (provider === "engineunicorn") {
      const services = await engineunicorn.getServices();
      const svc = services.find((s) => String(s.id) === String(service_id));
      if (!svc) {
        return res.status(404).json({
          success: false,
          error: { code: "SERVICE_NOT_FOUND", message: `Layanan dengan ID '${service_id}' tidak ditemukan di Server 2.` },
        });
      }
      providerPrice = svc.price;
      serviceName = svc.name;
      const price = db.calculatePrice("engineunicorn", providerPrice, svc.id, uid);
      const coin = db.getCoin(uid);
      if (coin < price) {
        return res.status(402).json({
          success: false,
          error: {
            code: "INSUFFICIENT_BALANCE",
            message: `Coin tidak cukup. Harga: ${rupiah(price)}, Coin kamu: ${rupiah(coin)}.`,
            required: price,
            balance: coin,
          },
        });
      }
      const deducted = db.deductCoin(uid, price);
      if (deducted === false) {
        return res.status(500).json({
          success: false,
          error: { code: "DEDUCT_FAILED", message: "Gagal memotong saldo." },
        });
      }
      await db.persistUser(uid);
      order = await engineunicorn.rent(svc.id);
      if (!order?.order_id || !order.phone) {
        db.addCoin(uid, price);
        await db.persistUser(uid);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: engineunicorn.getLastError() || "Gagal order nomor. Stok habis." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: apiUsername, orderId: order.order_id,
        phone: order.phone, productName: serviceName, negara: "Indonesia",
        harga: price, provider: "engineunicorn", serviceId: svc.id, providerPrice,
      });

      const expiryMs = Date.now() + 20 * 60 * 1000;
      const newSess = {
        userId: uid,
        step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
        provider: "engineunicorn", createdAt: new Date().toISOString(),
        serviceId: svc.id, serviceName, hargaUser: price, providerPrice,
        orderId: order.order_id, token: order.token || order.order_id,
        phone: order.phone, expiresAt: expiryMs, cancelAt: 0, retryCount: 0,
        trxId, sessionKey: trxId, source: "api",
      };
      wahubSessionDb.set(uid, newSess);
      if (typeof apiCallbacks.onOrderCreated === "function") {
        try { apiCallbacks.onOrderCreated(newSess); } catch (e) { console.error("[onOrderCreated error]:", e); }
      }

      sendChannelOrderReport({
        type: "WHATSAPP",
        username: apiUsername,
        userId: uid,
        saldo: db.getCoin(uid),
        serviceName,
        phone: order.phone,
        harga: price,
        modal: providerPrice,
        serverName: getProviderLabel("engineunicorn"),
        isNewOrder: true,
      }).catch(() => {});

      return res.status(201).json({
        success: true,
        data: {
          order_id: trxId,
          phone: order.phone,
          service: serviceName,
          provider: "server_2",
          server: "server_2",
          server_label: "Server 2 (WhatsApp)",
          price,
          balance_after: db.getCoin(uid),
          expires_at: new Date(expiryMs).toISOString(),
          status: "waiting",
        },
      });
    }

    // ── SMS providers ──
    if (provider === "fastbit") {
      let otpServiceId = req.body.otp_service_id;
      let countryObj = null;
      let chosenOffer = null;

      if (!otpServiceId) {
        const countries = await fastbit.getCountriesForService(service_id);
        if (!countries || !countries.length) {
          return res.status(404).json({
            success: false,
            error: { code: "SERVICE_NOT_FOUND", message: "Layanan atau negara tidak tersedia." },
          });
        }

        if (country_id) {
          const cId = String(country_id).trim().toUpperCase();
          countryObj = countries.find((c) => c.iso === cId || c.id === cId || c.name.toUpperCase().includes(cId));
        } else {
          countryObj = countries.find((c) => c.iso === "ID") || countries[0];
        }

        if (!countryObj || !countryObj.offers || !countryObj.offers.length) {
          return res.status(404).json({
            success: false,
            error: { code: "COUNTRY_NOT_FOUND", message: `Negara '${country_id || "default"}' tidak tersedia untuk layanan ini.` },
          });
        }

        if (operator_id) {
          const opId = String(operator_id).trim().toLowerCase();
          chosenOffer = countryObj.offers.find((o) => o.operator.toLowerCase() === opId || o.id === opId);
        }
        if (!chosenOffer) {
          chosenOffer = countryObj.offers[0];
        }
        otpServiceId = chosenOffer.id;
      }

      if (!chosenOffer) {
        providerPrice = Number(req.body.price) || 0;
      } else {
        providerPrice = chosenOffer.price;
      }

      serviceName = `SMS - ${service_id}`;
      const price = db.calculatePrice("fastbit", providerPrice, service_id, uid);
      const coin = db.getCoin(uid);
      if (coin < price) {
        return res.status(402).json({
          success: false,
          error: {
            code: "INSUFFICIENT_BALANCE",
            message: `Coin tidak cukup. Harga: ${rupiah(price)}, Coin kamu: ${rupiah(coin)}.`,
            required: price,
            balance: coin,
          },
        });
      }

      const deducted = db.deductCoin(uid, price);
      if (deducted === false) {
        return res.status(500).json({
          success: false,
          error: { code: "DEDUCT_FAILED", message: "Gagal memotong saldo." },
        });
      }
      await db.persistUser(uid);

      order = await fastbit.createOrder({ otpServiceId });
      if (!order?.order_uuid || !order.phone_number) {
        db.addCoin(uid, price);
        await db.persistUser(uid);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: fastbit.getLastError() || "Gagal order nomor SMS." },
        });
      }

      const countryName = countryObj?.name || country_id || "Indonesia";
      const trxId = db.addTransaction({
        userId: uid,
        username: apiUsername,
        orderId: order.order_uuid,
        phone: order.phone_number,
        productName: serviceName,
        negara: countryName,
        harga: price,
        provider: "fastbit",
        serviceId: service_id,
        countryId: country_id || countryObj?.iso || "ID",
        operatorId: chosenOffer?.operator || operator_id || "",
        providerPrice,
      });

      const expiryMs = order.expired_at || Date.now() + 20 * 60 * 1000;
      const newSess = {
        userId: uid,
        step: "tunggu_otp",
        status: "waiting",
        providerStatus: "waiting",
        provider: "fastbit",
        createdAt: new Date().toISOString(),
        serviceId: service_id,
        serviceName,
        hargaUser: price,
        providerPrice,
        orderId: order.order_uuid,
        orderUuid: order.order_uuid,
        numericOrderId: order.order_id,
        token: order.order_uuid,
        phone: order.phone_number,
        expiresAt: expiryMs,
        cancelAt: 0,
        retryCount: 0,
        trxId,
        sessionKey: trxId,
        source: "api",
        verificationType: "sms",
      };
      wahubSessionDb.set(uid, newSess);
      if (typeof apiCallbacks.onOrderCreated === "function") {
        try { apiCallbacks.onOrderCreated(newSess); } catch (e) { console.error("[onOrderCreated error]:", e); }
      }

      sendChannelOrderReport({
        type: "SMS",
        username: apiUsername,
        userId: uid,
        saldo: db.getCoin(uid),
        serviceName,
        phone: order.phone_number,
        harga: price,
        modal: providerPrice,
        serverName: getProviderLabel("fastbit"),
        isNewOrder: true,
      }).catch(() => {});

      return res.status(201).json({
        success: true,
        data: {
          order_id: trxId,
          phone: order.phone_number,
          service: serviceName,
          provider: "sms_1",
          server: "sms_1",
          server_label: "Server 1 (SMS)",
          price,
          balance_after: db.getCoin(uid),
          expires_at: new Date(expiryMs).toISOString(),
          status: "waiting",
        },
      });
    }

    if (provider === "herosms") {
      if (!country_id) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING_FIELD", message: "Field 'country_id' wajib untuk layanan SMS." },
        });
      }
      const price_info = await herosms.getPrices(service_id, country_id);
      if (!price_info) {
        return res.status(404).json({
          success: false,
          error: { code: "SERVICE_NOT_FOUND", message: "Layanan atau negara tidak ditemukan." },
        });
      }
      providerPrice = herosms.toIdrPrice(price_info.price || price_info.cost || 0);
      serviceName = `SMS - ${service_id}`;
      const price = db.calculatePrice("herosms", providerPrice, service_id, uid);
      const coin = db.getCoin(uid);
      if (coin < price) {
        return res.status(402).json({
          success: false,
          error: {
            code: "INSUFFICIENT_BALANCE",
            message: `Coin tidak cukup. Harga: ${rupiah(price)}, Coin kamu: ${rupiah(coin)}.`,
            required: price,
            balance: coin,
          },
        });
      }
      const deducted = db.deductCoin(uid, price);
      if (deducted === false) {
        return res.status(500).json({
          success: false,
          error: { code: "DEDUCT_FAILED", message: "Gagal memotong saldo." },
        });
      }
      await db.persistUser(uid);
      order = await herosms.createOrder(service_id, country_id, operator_id);
      if (!order?.order_id || !order.phone_number) {
        db.addCoin(uid, price);
        await db.persistUser(uid);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: herosms.getLastError() || "Gagal order nomor SMS." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: apiUsername, orderId: order.order_id,
        phone: order.phone_number, productName: serviceName, negara: country_id,
        harga: price, provider: "herosms", serviceId: service_id,
        countryId: country_id, operatorId: operator_id || "", providerPrice,
      });

      const expiryMs = Date.now() + 20 * 60 * 1000;
      const newSess = {
        userId: uid,
        step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
        provider: "herosms", createdAt: new Date().toISOString(),
        serviceId: service_id, serviceName, hargaUser: price, providerPrice,
        orderId: order.order_id, token: order.order_id,
        phone: order.phone_number, expiresAt: expiryMs, cancelAt: 0, retryCount: 0,
        trxId, sessionKey: trxId, source: "api", verificationType: "sms",
      };
      wahubSessionDb.set(uid, newSess);
      if (typeof apiCallbacks.onOrderCreated === "function") {
        try { apiCallbacks.onOrderCreated(newSess); } catch (e) { console.error("[onOrderCreated error]:", e); }
      }

      sendChannelOrderReport({
        type: "SMS",
        username: apiUsername,
        userId: uid,
        saldo: db.getCoin(uid),
        serviceName,
        phone: order.phone_number,
        harga: price,
        modal: providerPrice,
        serverName: getProviderLabel("herosms"),
        isNewOrder: true,
      }).catch(() => {});

      return res.status(201).json({
        success: true,
        data: {
          order_id: trxId,
          phone: order.phone_number,
          service: serviceName,
          provider: "sms_2",
          server: "sms_2",
          server_label: "Server 2 (SMS - FlashCall)",
          price,
          balance_after: db.getCoin(uid),
          expires_at: new Date(expiryMs).toISOString(),
          status: "waiting",
        },
      });
    }

    if (provider === "rumahotp") {
      if (!country_id) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING_FIELD", message: "Field 'country_id' wajib untuk layanan FlashCall / SMS." },
        });
      }
      const price_info = await herosms.getPrices(service_id, country_id);
      if (!price_info) {
        return res.status(404).json({
          success: false,
          error: { code: "SERVICE_NOT_FOUND", message: "Layanan atau negara tidak ditemukan." },
        });
      }
      providerPrice = herosms.toIdrPrice(price_info.price || price_info.cost || 0);
      serviceName = `FlashCall - ${service_id}`;
      const price = db.calculatePrice("rumahotp", providerPrice, service_id, uid);
      const coin = db.getCoin(uid);
      if (coin < price) {
        return res.status(402).json({
          success: false,
          error: {
            code: "INSUFFICIENT_BALANCE",
            message: `Coin tidak cukup. Harga: ${rupiah(price)}, Coin kamu: ${rupiah(coin)}.`,
            required: price,
            balance: coin,
          },
        });
      }
      const deducted = db.deductCoin(uid, price);
      if (deducted === false) {
        return res.status(500).json({
          success: false,
          error: { code: "DEDUCT_FAILED", message: "Gagal memotong saldo." },
        });
      }
      await db.persistUser(uid);
      order = await herosms.createOrder({
        serviceId: service_id,
        countryId: country_id,
        operatorId: operator_id,
        verification: true,
        verificationType: "flashcall",
      });
      if (!order?.order_id || !order.phone_number) {
        db.addCoin(uid, price);
        await db.persistUser(uid);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: herosms.getLastError() || "Gagal order nomor FlashCall." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: apiUsername, orderId: order.order_id,
        phone: order.phone_number, productName: serviceName, negara: country_id,
        harga: price, provider: "rumahotp", serviceId: service_id,
        countryId: country_id, operatorId: operator_id || "", providerPrice,
      });

      const expiryMs = Date.now() + 20 * 60 * 1000;
      const newSess = {
        userId: uid,
        step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
        provider: "rumahotp", createdAt: new Date().toISOString(),
        serviceId: service_id, serviceName, hargaUser: price, providerPrice,
        orderId: order.order_id, token: order.order_id,
        phone: order.phone_number, expiresAt: expiryMs, cancelAt: 0, retryCount: 0,
        trxId, sessionKey: trxId, source: "api", verificationType: "flashcall",
      };
      wahubSessionDb.set(uid, newSess);
      if (typeof apiCallbacks.onOrderCreated === "function") {
        try { apiCallbacks.onOrderCreated(newSess); } catch (e) { console.error("[onOrderCreated error]:", e); }
      }

      sendChannelOrderReport({
        type: "FLASHCALL",
        username: apiUsername,
        userId: uid,
        saldo: db.getCoin(uid),
        serviceName,
        phone: order.phone_number,
        harga: price,
        modal: providerPrice,
        serverName: getProviderLabel("rumahotp"),
        isNewOrder: true,
      }).catch(() => {});

      return res.status(201).json({
        success: true,
        data: {
          order_id: trxId,
          phone: order.phone_number,
          service: serviceName,
          provider: "sms_2",
          server: "sms_2",
          server_label: "Server 2 (SMS - FlashCall + SMS)",
          verification_type: "flashcall",
          price,
          balance_after: db.getCoin(uid),
          expires_at: new Date(expiryMs).toISOString(),
          status: "waiting",
        },
      });
    }

    return res.status(400).json({
      success: false,
      error: { code: "INVALID_PROVIDER", message: "Server tidak dikenali." },
    });
  } catch (error) {
    console.error("[API] Order error:", error);
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ── GET /api/v1/order/:id ───────────────────────────────────
// Check order status and get OTP
router.get("/order/:id", authMiddleware, async (req, res) => {
  try {
    const uid = req.apiUserId;
    const orderId = req.params.id;

    // Find from wahub session
    const sess = wahubSessionDb.find(uid, orderId);
    if (sess) {
      let otp = sess.lastOtp || sess.firstOtp || "";
      let status = "waiting";
      let smsMessage = "";

      if (sess.status === "paid" || sess.hasReceivedOtp || sess.paidAt) {
        status = "completed";
      } else if (["cancelled", "canceled", "failed", "expired"].includes(sess.status)) {
        status = sess.status;
      }

      // If still waiting, poll the provider for latest status
      if (status === "waiting") {
        try {
          let result;
          if (sess.provider === "engineunicorn") {
            result = await engineunicorn.checkSms(sess.token || sess.orderId, sess.orderId);
          } else if (sess.provider === "fastbit") {
            result = await fastbit.getOrder(sess.orderId || sess.orderUuid);
            if (result) {
              otp = result.otp_code || "";
              smsMessage = result.sms || "";
              if (otp || result.status === "received") status = "completed";
              else if (["canceled", "cancelled", "failed", "expired"].includes(result.status)) {
                status = result.status;
              }
            }
          } else if (sess.provider === "herosms" || sess.provider === "rumahotp" || sess.provider === "flashcall") {
            result = await herosms.getOrder(sess.orderId);
            if (result) {
              otp = result.otp_code || "";
              smsMessage = result.sms || "";
              if (otp) status = "completed";
            }
          } else {
            result = await wahub.checkSms(sess.token, sess.orderId);
          }

          if (result && !otp) {
            otp = result.otp || "";
            smsMessage = result.message || "";
            if (otp) status = "completed";
            const stateVal = result.state || result.status || "";
            if (["failed", "error", "cancelled", "canceled", "expired"].includes(stateVal)) {
              status = stateVal;
            }
          }
        } catch (e) {}
      }

      if (otp) {
        status = "completed";
        if (!sess.notifiedRealtime) {
          sess.notifiedRealtime = true;
          sess.hasReceivedOtp = true;
          sess.lastOtp = otp;
          sess.status = "completed";
          sess.paidAt = sess.paidAt || new Date().toISOString();
          wahubSessionDb.set(uid, sess);

          // 1. Kirim notifikasi realtime ke channel publik
          sendChannelRealtimeOtp({
            serviceName: sess.serviceName,
            phone: sess.phone,
            otp: otp,
            trxId: sess.trxId || orderId,
          }).catch(() => {});

          // 2. Kirim laporan order lengkap ke channel khusus admin
          const userObj = db.getUser(uid);
          const username = userObj?.username || `api_user_${uid}`;
          const isWa = ["wahub", "engineunicorn"].includes(sess.provider);
          sendChannelOrderReport({
            type: isWa ? "WHATSAPP" : "SMS",
            username,
            userId: uid,
            saldo: db.getCoin(uid),
            serviceName: sess.serviceName,
            phone: sess.phone,
            harga: sess.hargaUser,
            modal: sess.providerPrice || sess.hargaDasar || 0,
            otp: otp,
            serverName: getProviderLabel(sess.provider || "wahub"),
            isNewOrder: false,
          }).catch(() => {});
        }
      }

      return res.json({
        success: true,
        data: {
          order_id: orderId,
          phone: sess.phone,
          status,
          otp: otp || null,
          sms_message: smsMessage || null,
          service: sess.serviceName,
          provider: getPublicProviderCode(sess.provider || "wahub"),
          server: getPublicProviderCode(sess.provider || "wahub"),
          server_label: getProviderLabel(sess.provider || "wahub"),
          price: sess.hargaUser,
          created_at: sess.createdAt,
          expires_at: sess.expiresAt ? new Date(sess.expiresAt).toISOString() : null,
        },
      });
    }

    // Try from transaction history
    const trx = db.getTrxById(orderId);
    if (trx && String(trx.userId) === String(uid)) {
      return res.json({
        success: true,
        data: {
          order_id: trx.id,
          phone: trx.phone,
          status: trx.refunded ? "refunded" : "completed",
          otp: null,
          sms_message: null,
          service: trx.productName,
          provider: getPublicProviderCode(trx.provider),
          server: getPublicProviderCode(trx.provider),
          server_label: getProviderLabel(trx.provider),
          price: trx.harga,
          created_at: trx.date,
        },
      });
    }

    res.status(404).json({
      success: false,
      error: { code: "ORDER_NOT_FOUND", message: `Order dengan ID '${orderId}' tidak ditemukan.` },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ── POST /api/v1/order/:id/cancel ───────────────────────────
router.post("/order/:id/cancel", authMiddleware, async (req, res) => {
  try {
    const uid = req.apiUserId;
    const orderId = req.params.id;

    const sess = wahubSessionDb.find(uid, orderId);
    if (!sess) {
      return res.status(404).json({
        success: false,
        error: { code: "ORDER_NOT_FOUND", message: "Order tidak ditemukan atau sudah selesai." },
      });
    }

    if (sess.hasReceivedOtp || sess.paidAt || sess.status === "paid") {
      return res.status(409).json({
        success: false,
        error: { code: "ALREADY_PAID", message: "Order sudah menerima OTP dan tidak dapat dibatalkan." },
      });
    }

    if (!["waiting"].includes(sess.status)) {
      return res.status(409).json({
        success: false,
        error: { code: "INVALID_STATUS", message: `Order berstatus '${sess.status}' dan tidak dapat dibatalkan.` },
      });
    }

    // Cancel at provider
    let cancelled = false;
    if (sess.provider === "engineunicorn") {
      const result = await engineunicorn.cancel(sess.orderId);
      cancelled = result?.confirmed;
    } else if (sess.provider === "fastbit") {
      cancelled = await fastbit.cancelOrder(sess.orderId || sess.orderUuid);
    } else if (sess.provider === "herosms" || sess.provider === "rumahotp" || sess.provider === "flashcall") {
      cancelled = await herosms.cancelOrder(sess.orderId);
    } else {
      const result = await wahub.cancel(sess.orderId, sess.token);
      cancelled = result?.ok;
    }

    // Refund
    const refundResult = db.refundTransaction(sess.trxId, uid);
    await db.persistUser(uid);
    const refunded = refundResult?.refunded || refundResult?.alreadyRefunded || false;
    const refundAmount = refundResult?.amount || sess.hargaUser || 0;

    // Update session
    sess.status = "cancelled";
    sess.step = "selesai";
    sess.cancelledAt = new Date().toISOString();
    wahubSessionDb.set(uid, sess);

    res.json({
      success: true,
      data: {
        order_id: orderId,
        status: "cancelled",
        refunded,
        refund_amount: refundAmount,
        balance_after: db.getCoin(uid),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ── POST /api/v1/order/:id/retry ────────────────────────────
// Retry OTP (WhatsApp only)
router.post("/order/:id/retry", authMiddleware, async (req, res) => {
  try {
    const uid = req.apiUserId;
    const orderId = req.params.id;

    const sess = wahubSessionDb.find(uid, orderId);
    if (!sess) {
      return res.status(404).json({
        success: false,
        error: { code: "ORDER_NOT_FOUND", message: "Order tidak ditemukan." },
      });
    }

    if (!["wahub", "engineunicorn"].includes(sess.provider || "wahub")) {
      return res.status(400).json({
        success: false,
        error: { code: "NOT_SUPPORTED", message: "Minta ulang OTP hanya tersedia untuk provider WhatsApp." },
      });
    }

    const retryCount = Number(sess.retryCount) || 0;
    if (retryCount >= 3) {
      return res.status(429).json({
        success: false,
        error: { code: "MAX_RETRIES", message: "Batas minta ulang OTP sudah tercapai (3x)." },
      });
    }

    let result;
    if (sess.provider === "engineunicorn") {
      result = await engineunicorn.resend(sess.orderId);
      if (!result?.ok) {
        return res.status(502).json({
          success: false,
          error: { code: "RETRY_FAILED", message: engineunicorn.getLastError() || "Gagal minta ulang OTP." },
        });
      }
    } else {
      result = await wahub.retry(sess.token);
      if (!result?.token || !result.phone) {
        return res.status(502).json({
          success: false,
          error: { code: "RETRY_FAILED", message: wahub.getLastError() || "Gagal minta ulang OTP." },
        });
      }
      sess.token = result.token;
      sess.phone = result.phone;
    }

    sess.retryCount = retryCount + 1;
    sess.status = "waiting";
    sess.providerStatus = "waiting";
    sess.expiresAt = Date.now() + 20 * 60 * 1000;
    wahubSessionDb.set(uid, sess);

    res.json({
      success: true,
      data: {
        order_id: orderId,
        phone: sess.phone,
        retry_count: sess.retryCount,
        max_retries: 3,
        status: "waiting",
        expires_at: new Date(sess.expiresAt).toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ── GET /api/v1/history ─────────────────────────────────────
router.get("/history", authMiddleware, (req, res) => {
  try {
    const uid = req.apiUserId;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const riwayat = db.getRiwayat(uid, limit);

    res.json({
      success: true,
      data: riwayat.map((t) => ({
        order_id: t.id,
        phone: t.phone,
        service: t.productName,
        country: t.negara,
        price: t.harga,
        provider: getPublicProviderCode(t.provider),
        server: getPublicProviderCode(t.provider),
        server_label: getProviderLabel(t.provider),
        refunded: t.refunded || false,
        date: t.date,
      })),
      total: riwayat.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ══════════════════════════════════════════════════════════════
// CREATE & START EXPRESS APP
// ══════════════════════════════════════════════════════════════
function createApiServer(options = {}) {
  apiCallbacks = {
    onOrderCreated: options.onOrderCreated || null,
    sendRealtimeOtp: options.sendRealtimeOtp || null,
    sendOrderReport: options.sendOrderReport || null,
  };

  const app = express();

  // Global middleware
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // API routes
  app.use("/api/v1", router);

  // Serve static API docs
  app.use("/docs", express.static(path.join(__dirname, "public")));
  app.get("/docs", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "api-docs.html"));
  });

  // Root redirect to docs
  app.get("/", (req, res) => {
    res.redirect("/docs");
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: `Endpoint ${req.method} ${req.path} tidak ditemukan.` },
    });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error("[API Server Error]", err);
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Terjadi kesalahan internal." },
    });
  });

  return app;
}

module.exports = { createApiServer };
