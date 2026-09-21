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
const config = require("./config");
const db = require("./db");
const wahub = require("./lib/wahub");
const engineunicorn = require("./lib/engineunicorn");
const herosms = require("./lib/herosms");
const rumahotp = require("./lib/rumahotp");
const apiKeys = require("./lib/api-keys");
const wahubSessionDb = require("./wahub-session-db");
const path = require("path");

const router = express.Router();

// ══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════════════

// ── Auth middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid Authorization header. Use: Bearer ck_live_xxx",
      },
    });
  }

  const key = authHeader.slice(7).trim();
  const keyData = apiKeys.validateApiKey(key);
  if (!keyData) {
    return res.status(401).json({
      success: false,
      error: {
        code: "INVALID_API_KEY",
        message: "API key tidak valid atau sudah direvoke.",
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
  req.apiUserId = keyData.userId;
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
  if (["server_2", "server2", "wa2", "whatsapp2", "engineunicorn"].includes(p)) return "engineunicorn";
  if (["sms_1", "sms1", "sms_server1", "herosms", "hero"].includes(p)) return "herosms";
  if (["sms_2", "sms2", "sms_server2", "rumahotp", "rumah"].includes(p)) return "rumahotp";
  return p;
}

function getPublicProviderCode(internalProvider) {
  const map = {
    wahub: "server_1",
    engineunicorn: "server_2",
    herosms: "sms_1",
    rumahotp: "sms_2",
  };
  return map[internalProvider] || internalProvider;
}

function getProviderLabel(provider) {
  const labels = {
    wahub: "Server 1 (WhatsApp)",
    engineunicorn: "Server 2 (WhatsApp)",
    herosms: "Server 1 (SMS)",
    rumahotp: "Server 2 (SMS)",
    server_1: "Server 1 (WhatsApp)",
    server_2: "Server 2 (WhatsApp)",
    sms_1: "Server 1 (SMS)",
    sms_2: "Server 2 (SMS)",
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
    if (!provider || provider === "herosms") {
      if (db.getProviderStatus("herosms") !== false) {
        try {
          const services = await herosms.getServices();
          result.sms.push(
            ...services
              .filter((s) => s.id && s.name)
              .map((s) => ({
                service_id: String(s.id),
                name: s.name,
                price: db.calculatePrice("herosms", s.price || 0, s.id, req.apiUserId),
                stock: Number(s.stock) || 0,
                provider: "sms_1",
                server: "sms_1",
                server_label: "Server 1 (SMS)",
                type: "sms",
              }))
          );
        } catch (e) {}
      }
    }

    if (!provider || provider === "rumahotp") {
      if (db.getProviderStatus("rumahotp") !== false) {
        try {
          const services = await rumahotp.getServices();
          result.sms.push(
            ...services
              .filter((s) => s.id && s.name)
              .map((s) => ({
                service_id: String(s.id),
                name: s.name,
                price: db.calculatePrice("rumahotp", s.price || 0, s.id, req.apiUserId),
                stock: Number(s.stock) || 0,
                provider: "sms_2",
                server: "sms_2",
                server_label: "Server 2 (SMS)",
                type: "sms",
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

// ── GET /api/v1/balance ─────────────────────────────────────
router.get("/balance", authMiddleware, (req, res) => {
  try {
    const uid = req.apiUserId;
    const coin = db.getCoin(uid);
    const user = db.getUser(uid);
    res.json({
      success: true,
      data: {
        balance: coin,
        balance_formatted: rupiah(coin),
        is_reseller: Boolean(user?.isReseller),
        total_trx: user?.trx || 0,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    });
  }
});

// ── POST /api/v1/order ──────────────────────────────────────
// Order a new OTP number
router.post("/order", authMiddleware, async (req, res) => {
  try {
    const uid = req.apiUserId;
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
    const validProviders = ["wahub", "engineunicorn", "herosms", "rumahotp"];
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
      order = await wahub.rent(svc.id);
      if (!order?.order_id || !order.token || !order.phone) {
        db.addCoin(uid, price);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: wahub.getLastError() || "Gagal order nomor. Stok habis." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: "api_user", orderId: order.order_id,
        phone: order.phone, productName: serviceName, negara: "Indonesia",
        harga: price, provider: "wahub", serviceId: svc.id, providerPrice,
      });

      // Create wahub session for polling
      const expiryMs = Date.now() + 20 * 60 * 1000;
      wahubSessionDb.set(uid, {
        step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
        provider: "wahub", createdAt: new Date().toISOString(),
        serviceId: svc.id, serviceName, hargaUser: price,
        orderId: order.order_id, token: order.token, phone: order.phone,
        expiresAt: expiryMs, cancelAt: 0, retryCount: 0, trxId,
        sessionKey: trxId, source: "api",
      });

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
      order = await engineunicorn.rent(svc.id);
      if (!order?.order_id || !order.phone) {
        db.addCoin(uid, price);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: engineunicorn.getLastError() || "Gagal order nomor. Stok habis." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: "api_user", orderId: order.order_id,
        phone: order.phone, productName: serviceName, negara: "Indonesia",
        harga: price, provider: "engineunicorn", serviceId: svc.id, providerPrice,
      });

      const expiryMs = Date.now() + 20 * 60 * 1000;
      wahubSessionDb.set(uid, {
        step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
        provider: "engineunicorn", createdAt: new Date().toISOString(),
        serviceId: svc.id, serviceName, hargaUser: price,
        orderId: order.order_id, token: order.token || order.order_id,
        phone: order.phone, expiresAt: expiryMs, cancelAt: 0, retryCount: 0,
        trxId, sessionKey: trxId, source: "api",
      });

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
      order = await herosms.createOrder(service_id, country_id, operator_id);
      if (!order?.order_id || !order.phone_number) {
        db.addCoin(uid, price);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: herosms.getLastError() || "Gagal order nomor SMS." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: "api_user", orderId: order.order_id,
        phone: order.phone_number, productName: serviceName, negara: country_id,
        harga: price, provider: "herosms", serviceId: service_id,
        countryId: country_id, operatorId: operator_id || "", providerPrice,
      });

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
          status: "waiting",
        },
      });
    }

    if (provider === "rumahotp") {
      if (!country_id) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING_FIELD", message: "Field 'country_id' wajib untuk layanan SMS." },
        });
      }
      serviceName = `SMS - ${service_id}`;
      // Get price from rumahotp services
      const roServices = await rumahotp.getServices();
      const roSvc = Array.isArray(roServices)
        ? roServices.find((s) => String(s.id) === String(service_id))
        : null;
      providerPrice = roSvc?.price || 0;
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
      order = await rumahotp.buyNumber(service_id, country_id, operator_id);
      if (!order?.order_id || !order.phone) {
        db.addCoin(uid, price);
        return res.status(502).json({
          success: false,
          error: { code: "ORDER_FAILED", message: rumahotp.getLastError() || "Gagal order nomor SMS." },
        });
      }
      const trxId = db.addTransaction({
        userId: uid, username: "api_user", orderId: order.order_id,
        phone: order.phone, productName: serviceName, negara: country_id,
        harga: price, provider: "rumahotp", serviceId: service_id,
        countryId: country_id, operatorId: operator_id || "", providerPrice,
      });

      return res.status(201).json({
        success: true,
        data: {
          order_id: trxId,
          phone: order.phone,
          service: serviceName,
          provider: "sms_2",
          server: "sms_2",
          server_label: "Server 2 (SMS)",
          price,
          balance_after: db.getCoin(uid),
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
          } else if (sess.provider === "herosms") {
            result = await herosms.getOrder(sess.orderId);
            if (result) {
              otp = result.otp_code || "";
              smsMessage = result.sms || "";
              if (otp) status = "completed";
            }
          } else if (sess.provider === "rumahotp") {
            result = await rumahotp.getOrder(sess.orderId);
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
    } else if (sess.provider === "herosms") {
      cancelled = await herosms.cancelOrder(sess.orderId);
    } else if (sess.provider === "rumahotp") {
      cancelled = await rumahotp.cancelOrder(sess.orderId);
    } else {
      const result = await wahub.cancel(sess.orderId, sess.token);
      cancelled = result?.ok;
    }

    // Refund
    const refundResult = db.refundTransaction(sess.trxId, uid);
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
function createApiServer() {
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
