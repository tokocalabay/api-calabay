const axios = require("axios");
const crypto = require("crypto");
const config = require("../config");

let lastError = null;
let servicesCache = null;
let servicesCacheTime = 0;
const SERVICES_CACHE_TTL = 10_000; // 10 detik TTL cache

function getApiKey() {
  return String(
    process.env.NINJAOTP_API_KEY ||
    config.NINJAOTP_API_KEY ||
    process.env.ENGINEUNICORN_API_KEY ||
    config.ENGINEUNICORN_API_KEY ||
    ""
  ).trim();
}

function getBaseUrl() {
  return String(
    process.env.NINJAOTP_API_URL ||
    config.NINJAOTP_API_URL ||
    process.env.ENGINEUNICORN_API_URL ||
    config.ENGINEUNICORN_API_URL ||
    "https://app.ninjatop.cloud/api/public/v1"
  ).trim().replace(/\/+$/, "");
}

function getLastError() {
  return lastError;
}

function errorMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (payload.error) {
    if (typeof payload.error === "string") return payload.error.trim();
    if (payload.error.message) return payload.error.message.trim();
    if (payload.error.code) return payload.error.code.trim();
  }
  return String(payload.message || payload.msg || payload.detail || "").trim();
}

function ensureKey() {
  if (!getApiKey()) {
    lastError = "API Key belum diatur di config.js.";
    return false;
  }
  return true;
}

const client = axios.create({
  timeout: 15_000,
  headers: { Accept: "application/json" },
});

async function request(name, method, endpoint, data = null, headers = {}) {
  if (!ensureKey()) return null;
  const url = `${getBaseUrl()}${endpoint}`;
  try {
    const response = await client.request({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        ...headers,
      },
    });
    lastError = null;
    return response.data;
  } catch (error) {
    const errData = error.response?.data;
    const msg = errorMessage(errData) || error.message || `NinjaOTP gagal memproses ${name}.`;
    lastError = msg;
    console.error(`[NINJAOTP ${name}] Error:`, msg);
    return null;
  }
}

function normalizeOtp(value) {
  const compact = String(value ?? "").trim().replace(/[\s-]/g, "");
  return /^\d{4,8}$/.test(compact) ? compact : "";
}

function extractOtp(text) {
  const message = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();
  if (!message) return "";

  const labelled = message.match(
    /(?:otp|one[-\s]?time|code|kode|pin|verification|verifikasi|passcode|security)[^\d]{0,40}(?:(\d[\s-]?){4,8})(?!\d)/i
  );
  if (labelled) {
    const code = normalizeOtp(labelled[1]);
    if (code) return code;
  }

  const tokens = [...message.matchAll(/(?:^|\D)((?:\d[\s-]?){4,8})(?=\D|$)/g)]
    .map((match) => normalizeOtp(match[1]))
    .filter(Boolean);
  return tokens.length === 1 ? tokens[0] : "";
}

async function getServices(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache && (now - servicesCacheTime < SERVICES_CACHE_TTL)) {
    return servicesCache;
  }

  const res = await request("getServices", "GET", "/services?page=1&size=200");
  const rawList = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
  const services = rawList
    .map((s) => ({
      id: String(s.id),
      name: String(s.name || "").trim(),
      price: Number(s.price) || 0,
      duration_seconds: (Number(s.duration) || 20) * 60, // Ninja OTP duration is in minutes
      stock: Number(s.available_count ?? s.stock ?? 0),
    }))
    .filter((s) => s.id && s.name);

  if (services.length > 0) {
    servicesCache = services;
    servicesCacheTime = now;
  }
  return services.length > 0 ? services : (servicesCache || []);
}

async function rent(serviceId) {
  if (!ensureKey()) return null;
  const idempotencyKey = crypto.randomUUID();
  const res = await request(
    "rent",
    "POST",
    "/orders",
    { service_id: Number(serviceId), qty: 1 },
    {
      "Idempotency-Key": idempotencyKey,
      "Content-Type": "application/json",
    }
  );

  const orderData = res?.orders?.[0] || res?.data?.orders?.[0] || (Array.isArray(res?.data) ? res.data[0] : res?.data);
  if (!orderData || !orderData.id || !orderData.phone_number) {
    return null;
  }

  const expiresAt = orderData.expire_at
    ? orderData.expire_at * 1000
    : Date.now() + 20 * 60 * 1000;

  return {
    order_id: String(orderData.id),
    token: String(orderData.id),
    phone: String(orderData.phone_number),
    expires_at: expiresAt,
    price: Number(orderData.price) || 0,
    service_id: String(orderData.service_id),
    service_name: String(orderData.service_name || ""),
    raw: orderData,
  };
}

async function getOrder(orderId) {
  if (!orderId) return null;
  const res = await request("getOrder", "GET", `/orders/${encodeURIComponent(orderId)}`);
  const data = res?.data?.id ? res.data : (res?.id ? res : res?.data);
  if (!data || typeof data !== "object") return null;

  const rawOtp = data.otp_code || data.otp || null;
  const fullText = data.full_text || data.message || "";
  const otp = normalizeOtp(rawOtp) || extractOtp(fullText);

  let state = "waiting";
  const status = String(data.status || "pending").toLowerCase();
  if (otp) {
    state = "success";
  } else if (["cancelled", "canceled", "expired"].includes(status)) {
    state = "cancelled";
  } else {
    state = "waiting";
  }

  const expiresAt = data.expire_at ? data.expire_at * 1000 : 0;

  return {
    order_id: String(data.id),
    token: String(data.id),
    phone: String(data.phone_number || ""),
    status: String(data.status || "pending"),
    state,
    otp,
    message: fullText,
    price: Number(data.price) || 0,
    expires_at: expiresAt,
    raw: data,
  };
}

async function checkSms(token, orderId = null) {
  const targetId = orderId || token;
  const order = await getOrder(targetId);
  if (!order) {
    return { state: "waiting", otp: "", message: "" };
  }
  return {
    state: order.state,
    otp: order.otp || "",
    message: order.message || "",
    order,
  };
}

async function cancel(orderId) {
  if (!orderId) return { confirmed: false, error: "ID pesanan tidak valid" };
  try {
    const res = await request("cancel", "POST", `/orders/${encodeURIComponent(orderId)}/cancel`);
    if (res?.status === "cancelled" || res?.data?.status === "cancelled" || res?.id || res?.data?.id) {
      return {
        confirmed: true,
        refunded: true,
        refundAmount: 0,
        response: res,
      };
    }
    if (lastError && /sudah selesai|completed/i.test(lastError)) {
      return { confirmed: false, reason: "completed", error: lastError };
    }
    return { confirmed: false, error: lastError || "Gagal membatalkan pesanan." };
  } catch (err) {
    return { confirmed: false, error: err.message };
  }
}

async function resend(orderId) {
  if (!orderId) return { ok: false, error: "ID pesanan tidak valid" };
  const res = await request("resend", "POST", `/orders/${encodeURIComponent(orderId)}/resend`);
  if (res?.resent || res?.data?.resent || res?.id || res?.data?.id) {
    return { ok: true, data: res };
  }
  return { ok: false, error: lastError || "Gagal meminta ulang OTP." };
}

async function getBalance() {
  const res = await request("getBalance", "GET", "/balance");
  const balance = res?.balance !== undefined ? res.balance : res?.data?.balance;
  if (balance !== undefined && balance !== null) {
    return {
      balance: Number(balance) || 0,
      currency: "IDR",
    };
  }
  return null;
}

module.exports = {
  getServices,
  rent,
  getOrder,
  checkSms,
  cancel,
  resend,
  getBalance,
  getLastError,
  normalizeOtp,
  extractOtp,
};
