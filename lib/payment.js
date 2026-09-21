const axios = require("axios");
const crypto = require("crypto");

// ── Payment Gateway PanzzPay API (https://panzzpay.my.id/docs) ────

/**
 * Normalisasi konfigurasi PanzzPay dari config.PAYMENT_GATEWAY / config.PANZZPAY.
 */
function getPaymentConfig(config) {
  const gw = config.PANZZPAY || config.PAYMENT_GATEWAY || config.PAYQRIS || {};
  return {
    baseUrl: (gw.baseUrl || "https://panzzpay.my.id").replace(/\/+$/, ""),
    apiKey: gw.apiKey || gw.apikey || process.env.PANZZPAY_API_KEY || process.env.PAYMENT_API_KEY || "",
    webhookUrl: gw.webhookUrl || gw.webhook_url || "https://panzzpay.my.id/webhook",
    botName: gw.botName || gw.bot_name || "Toko Calabay",
    expiredInMinutes: Number(gw.expiredInMinutes) || 15,
    pollIntervalMs: Number(gw.pollIntervalMs) || 4000,
  };
}

/**
 * Membuat invoice pembayaran QRIS Dinamis melalui PanzzPay API.
 * Endpoint: POST https://panzzpay.my.id/api/payment
 *
 * @param {number|string} amount - Nominal dasar pembayaran
 * @param {object} config - Objek konfigurasi bot
 * @param {object} [options] - Opsi tambahan (e.g. { orderId: 'DEP-12345' })
 */
async function createPayment(amount, config, options = {}) {
  const payCfg = getPaymentConfig(config);
  if (!payCfg.apiKey || payCfg.apiKey === "YOUR_PANZZPAY_API_KEY") {
    throw new Error("API key PanzzPay belum dikonfigurasi di config.js (field 'apiKey')");
  }

  const numericAmount = Math.round(Number(amount));
  if (isNaN(numericAmount) || numericAmount <= 0) {
    throw new Error("Nominal pembayaran tidak valid");
  }

  const customerOrderId = options.orderId || options.customerOrderId || `DEP-${Date.now()}`;

  const payload = {
    amount: numericAmount,
    customer_order_id: customerOrderId,
    bot_name: payCfg.botName,
    expiry_minutes: payCfg.expiredInMinutes,
    use_unique_code: true,
  };

  if (payCfg.webhookUrl) {
    payload.webhook_url = payCfg.webhookUrl;
  }

  try {
    const res = await axios.post(
      `${payCfg.baseUrl}/api/payment`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": payCfg.apiKey,
        },
        timeout: 25000,
      }
    );

    const result = res.data?.data || res.data;
    const orderId = result.id || result.transaction_id;

    if (!orderId) {
      throw new Error(res.data?.message || res.data?.error || "Gagal membuat invoice PanzzPay");
    }

    const originalAmount = Number(result.amount || numericAmount);
    const totalAmount = Number(result.unique_amount || result.total || originalAmount);
    const uniqueFee = Math.max(0, totalAmount - originalAmount);

    // Siapkan Buffer QR jika format data base64 tersedia
    let qrBuffer = null;
    const rawQrImage = result.qr_data_url || result.qr_png_data_url;
    if (rawQrImage && typeof rawQrImage === "string" && rawQrImage.startsWith("data:image/")) {
      try {
        const base64Data = rawQrImage.replace(/^data:image\/\w+;base64,/, "");
        qrBuffer = Buffer.from(base64Data, "base64");
      } catch (e) {
        console.error("[PANZZPAY QR BUFFER ERROR]", e.message);
      }
    }

    const expiresAtMs = typeof result.expires_at === "number"
      ? result.expires_at
      : (result.expires_at ? new Date(result.expires_at).getTime() : Date.now() + payCfg.expiredInMinutes * 60 * 1000);

    return {
      id: orderId,
      orderId,
      transactionId: orderId,
      customerOrderId: result.customer_order_id || customerOrderId,
      amount: totalAmount,
      totalAmount,
      originalAmount,
      fee: uniqueFee,
      providerFee: uniqueFee,
      uniqueCode: uniqueFee,
      qris: result.qris_payload || rawQrImage || null,
      qrPayload: result.qris_payload || null,
      qrDataUrl: rawQrImage || null,
      qrBuffer,
      paymentUrl: result.status_url || null,
      statusUrl: result.status_url || null,
      expiredAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      status: result.status || "pending",
      provider: "PanzzPay",
      raw: res.data,
    };
  } catch (error) {
    const errorMsg =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message;
    throw new Error("Terjadi kesalahan pada Payment Gateway (PanzzPay): " + errorMsg);
  }
}

/**
 * Cek status pembayaran ke PanzzPay API.
 * Endpoint: GET https://panzzpay.my.id/api/payment?transaction_id={orderId}
 * Header: x-api-key: YOUR_API_KEY
 *
 * @param {object} data - { orderId: "PAY-xxxx" } atau { transactionId: "PAY-xxxx" }
 * @param {object} config - Objek konfigurasi bot
 * @returns {Promise<boolean>} - True jika pembayaran berstatus paid/success
 */
async function cekPaid(data, config) {
  const payCfg = getPaymentConfig(config);
  const transactionId = data.orderId || data.transactionId || data.id || data.invoiceId;

  if (!transactionId || !payCfg.apiKey || payCfg.apiKey === "YOUR_PANZZPAY_API_KEY") {
    return false;
  }

  try {
    const res = await axios.get(`${payCfg.baseUrl}/api/payment`, {
      params: {
        transaction_id: transactionId,
      },
      headers: {
        "x-api-key": payCfg.apiKey,
      },
      timeout: 10000,
    });

    const status = String(res.data?.status || res.data?.data?.status || "").toLowerCase();
    return ["paid", "success", "sukses", "completed"].includes(status);
  } catch (error) {
    console.error(
      "Gagal mengecek status Payment Gateway (PanzzPay):",
      error.response?.data?.error || error.response?.data?.message || error.message
    );
    return false;
  }
}

/**
 * Mendapatkan detail status lengkap dari transaksi PanzzPay.
 * @param {object} data - { orderId: "PAY-xxxx" }
 * @param {object} config - Objek konfigurasi bot
 */
async function getPaymentStatus(data, config) {
  const payCfg = getPaymentConfig(config);
  const transactionId = data.orderId || data.transactionId || data.id || data.invoiceId;

  if (!transactionId || !payCfg.apiKey || payCfg.apiKey === "YOUR_PANZZPAY_API_KEY") {
    return { status: "unknown", isPaid: false, isExpired: false };
  }

  try {
    const res = await axios.get(`${payCfg.baseUrl}/api/payment`, {
      params: { transaction_id: transactionId },
      headers: { "x-api-key": payCfg.apiKey },
      timeout: 10000,
    });

    const status = String(res.data?.status || res.data?.data?.status || "").toLowerCase();
    return {
      status,
      isPaid: ["paid", "success", "sukses", "completed"].includes(status),
      isExpired: ["expired", "timeout"].includes(status),
      raw: res.data,
    };
  } catch (error) {
    return {
      status: "error",
      isPaid: false,
      isExpired: false,
      error: error.response?.data?.error || error.message,
    };
  }
}

/**
 * Membatalkan tagihan QRIS di PanzzPay API (menghentikan poller mutasi VPS gateway).
 * Endpoint: POST https://panzzpay.my.id/api/payment/cancel
 *
 * @param {string} orderId - ID invoice / transaksi (PAY-xxxx)
 * @param {object} config - Objek konfigurasi bot
 */
async function cancelQris(orderId, config) {
  if (!orderId) return false;

  const payCfg = getPaymentConfig(config);
  if (!payCfg.apiKey || payCfg.apiKey === "YOUR_PANZZPAY_API_KEY") {
    return Boolean(orderId);
  }

  try {
    const res = await axios.post(
      `${payCfg.baseUrl}/api/payment/cancel`,
      {
        transaction_id: orderId,
        id: orderId,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": payCfg.apiKey,
        },
        timeout: 10000,
      }
    );

    return Boolean(res.data?.success || res.data?.ok);
  } catch (error) {
    console.error(
      "Gagal membatalkan invoice PanzzPay di gateway:",
      error.response?.data?.error || error.response?.data?.message || error.message
    );
    return false;
  }
}

/**
 * Verifikasi signature webhook PanzzPay (HMAC-SHA256).
 * Sesuai dokumentasi resmi PanzzPay:
 * Header: X-Signature: HMAC-SHA256-HEX-STRING
 *
 * @param {string} rawBodyString - Raw body request webhook
 * @param {string} signatureHeader - Nilai header X-Signature
 * @param {string} webhookSecret - Secret key webhook PanzzPay
 * @returns {boolean}
 */
function verifyWebhook(rawBodyString, signatureHeader, webhookSecret) {
  if (!rawBodyString || !signatureHeader || !webhookSecret) return false;
  try {
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBodyString)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expectedSignature)
    );
  } catch (e) {
    return false;
  }
}

module.exports = {
  createPayment,
  cekPaid,
  getPaymentStatus,
  cancelQris,
  getPaymentConfig,
  getPayqrisConfig: getPaymentConfig, // Alias backward compatibility
  verifyWebhook,
};