const axios = require("axios");
const config = require("../config");

const API = axios.create({
  baseURL: process.env.WAHUB_API_URL || config.WAHUB_API_URL || "https://dehuyzotp.shop",
  timeout: 15_000,
  headers: { Accept: "application/json" },
});

let lastError = null;
let servicesCache = null;
let servicesCacheTime = 0;
const SERVICES_CACHE_TTL = 6_000; // 6 seconds TTL cache

function getToken() {
  return String(process.env.WAHUB_API_TOKEN || config.WAHUB_API_TOKEN || "").trim();
}

function errorMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  return String(payload.message || payload.error || payload.msg || payload.detail || "").trim();
}

function ensureToken() {
  if (!getToken()) {
    lastError = "API Token belum diatur di environment.";
    return false;
  }
  return true;
}

async function request(name, method, url, data, params) {
  if (!ensureToken()) return null;
  try {
    const response = await API.request({
      method,
      url,
      data,
      params,
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    lastError = null;
    return response.data;
  } catch (error) {
    lastError = errorMessage(error.response?.data) || error.message || `Gagal memproses ${name}.`;
    console.error(`WAHUB ${name}:`, error.response?.data || error.message);
    return null;
  }
}

function unwrap(value) {
  if (typeof value === "string") {
    try { return unwrap(JSON.parse(value)); } catch { return value; }
  }
  if (!value || typeof value !== "object") return value;
  for (const key of ["data", "result", "order", "response"]) {
    if (value[key] !== undefined) return unwrap(value[key]);
  }
  return value;
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
    /(?:otp|one[-\s]?time|code|kode|pin|verification|verifikasi|passcode|security)[^\d]{0,40}((?:\d[\s-]?){4,8})(?!\d)/i
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

function normalizeService(value) {
  const service = value && typeof value === "object" ? value : {};
  const price = Number(service.price);
  const stock = Number(service.stock);
  return {
    id: String(service.id ?? "").trim(),
    name: String(service.name ?? "").trim(),
    price: Number.isFinite(price) && price >= 0 ? price : 0,
    stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
  };
}

async function getServices(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && servicesCache && (now - servicesCacheTime < SERVICES_CACHE_TTL)) {
    return servicesCache;
  }
  const data = unwrap(await request("services", "GET", "/api/services"));
  const values = Array.isArray(data) ? data : Array.isArray(data?.services) ? data.services : [];
  const services = values.map(normalizeService).filter((service) => service.id && service.name);
  if (services.length > 0) {
    servicesCache = services;
    servicesCacheTime = now;
  }
  return services.length > 0 ? services : (servicesCache || []);
}

function normalizeOrder(value) {
  const order = unwrap(value);
  if (!order || typeof order !== "object") return null;
  const orderId = String(order.order_id ?? order.orderId ?? order.id ?? "").trim();
  const token = String(order.token ?? "").trim();
  const phone = String(order.phone ?? order.phone_number ?? order.phoneNumber ?? "").trim();
  const expiresAt = Number(order.expires_at ?? order.expiresAt ?? 0);
  if (!orderId || !token || !phone) return null;
  return {
    ...order,
    order_id: orderId,
    token,
    phone,
    expires_at: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

async function rent(serviceId) {
  return normalizeOrder(await request("rent", "POST", "/api/rent", { service_id: Number(serviceId) }));
}

async function getOrder(idOrToken) {
  if (!ensureToken() || !idOrToken) return null;
  try {
    const res = await request("order", "GET", `/api/order/${encodeURIComponent(idOrToken)}`);
    const raw = unwrap(res);
    if (!raw || typeof raw !== "object") return null;
    const message = String(raw.message ?? raw.text ?? raw.sms ?? raw.otp_msg ?? "");
    const otp = normalizeOtp(raw.otp) ||
      normalizeOtp(raw.otp_code) ||
      normalizeOtp(raw.code) ||
      extractOtp(message);
    const state = normalizeWahubStatus(raw.state || raw.status || (otp ? "success" : "waiting"));
    return {
      ...raw,
      order_id: raw.order_id ?? raw.orderId ?? idOrToken,
      token: raw.token ?? idOrToken,
      phone: String(raw.phone ?? raw.phone_number ?? raw.phoneNumber ?? ""),
      state,
      otp,
      message,
    };
  } catch (error) {
    return null;
  }
}

async function checkSms(token, orderId = null) {
  if (!ensureToken()) return { state: "", otp: "", message: "" };
  try {
    const response = await API.request({
      method: "GET",
      url: `/api/sms/${encodeURIComponent(token)}`,
      params: { timeout: 10 },
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    lastError = null;
    const raw = unwrap(response.data);
    if (raw && typeof raw === "object") {
      const message = String(raw.message ?? raw.text ?? raw.sms ?? raw.otp_msg ?? "");
      const otp = normalizeOtp(raw.otp) ||
        normalizeOtp(raw.otp_code) ||
        normalizeOtp(raw.code) ||
        extractOtp(message);
      if (otp) {
        return {
          ...raw,
          state: "success",
          otp,
          message,
        };
      }
      const rawState = String(raw.state ?? "").toLowerCase();
      const rawStatus = String(raw.status ?? "").toLowerCase();
      if (["cancel", "canceled", "cancelled"].includes(rawState) || ["cancel", "canceled", "cancelled"].includes(rawStatus)) {
        return { ...raw, state: "cancelled", otp: "", message };
      }
      if (["expired", "timeout"].includes(rawState) || ["expired", "timeout"].includes(rawStatus)) {
        return { ...raw, state: "expired", otp: "", message };
      }
      if (["failed", "error"].includes(rawState) || ["failed", "error"].includes(rawStatus)) {
        return { ...raw, state: "failed", otp: "", message };
      }
      // Without OTP, order is still waiting
      return {
        ...raw,
        state: "waiting",
        otp: "",
        message,
      };
    }
  } catch (error) {
    const errData = error.response?.data;
    const errMsg = errorMessage(errData) || error.message || "";
    const status = error.response?.status;
    if (status === 410 || status === 404 || /terminal|success|selesai|done/i.test(errMsg)) {
      const orderInfo = await getOrder(token) || (orderId ? await getOrder(orderId) : null);
      if (orderInfo?.otp) {
        return {
          ...orderInfo,
          state: "success",
          otp: orderInfo.otp,
          message: orderInfo.message,
        };
      }
    }
    if (/timeout/i.test(errMsg) || error.code === "ECONNABORTED") {
      const orderInfo = await getOrder(token) || (orderId ? await getOrder(orderId) : null);
      if (orderInfo?.otp) {
        return {
          ...orderInfo,
          state: "success",
          otp: orderInfo.otp,
          message: orderInfo.message,
        };
      }
      return { state: "waiting", otp: "", message: "" };
    }
    lastError = errMsg;
  }

  try {
    const orderInfo = await getOrder(token) || (orderId ? await getOrder(orderId) : null);
    if (orderInfo?.otp) {
      return {
        ...orderInfo,
        state: "success",
        otp: orderInfo.otp,
        message: orderInfo.message,
      };
    }
  } catch (e) {}

  return { state: "waiting", otp: "", message: "" };
}

async function retry(token) {
  return normalizeOrder(await request("retry", "POST", `/api/rent/${encodeURIComponent(token)}/retry`));
}

async function cancel(id, token = null) {
  if (!ensureToken()) return null;

  const tryCancel = async (targetId, isDelete = false) => {
    if (!targetId) return null;
    try {
      const response = await API.request({
        method: isDelete ? "DELETE" : "POST",
        url: isDelete
          ? `/api/rent/${encodeURIComponent(targetId)}`
          : `/api/order/${encodeURIComponent(targetId)}`,
        data: isDelete ? undefined : { action: "cancel" },
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      lastError = null;
      return response.data;
    } catch (error) {
      const errData = error.response?.data;
      const errMsg = errorMessage(errData) || error.message || "";
      lastError = errMsg;
      const status = error.response?.status;
      if (
        status === 404 ||
        /no pending order|not found|already cancel|tidak ditemukan|no order/i.test(errMsg)
      ) {
        // Order is no longer active on provider side (already cancelled / released)
        return { ok: true, state: "cancelled", released: true, message: errMsg };
      }
      console.error(`WAHUB cancel (${isDelete ? "DELETE" : "POST"} ${targetId}):`, errData || error.message);
      return null;
    }
  };

  let res = await tryCancel(id);
  if ((!res || res.ok !== true) && token && String(token) !== String(id)) {
    res = await tryCancel(token);
    if (!res || res.ok !== true) {
      res = await tryCancel(token, true);
    }
  }

  const response = unwrap(res) || res;
  if (!response || typeof response !== "object") return response;
  return {
    ...response,
    ok: response.ok === true || Boolean(response.released),
    order_id: response.order_id ?? response.orderId ?? id,
    state: String(response.state ?? response.status ?? "cancelled").toLowerCase(),
    refunded: Number(response.refunded ?? 0),
  };
}

async function getBalance() {
  const data = unwrap(await request("balance", "GET", "/api/balance"));
  if (!data || typeof data !== "object") return null;
  return {
    balance: Number(data.balance) || 0,
    reserved: Number(data.reserved) || 0,
    available: Number(data.available) || 0,
  };
}

function getLastError() {
  return lastError;
}

module.exports = {
  getServices,
  rent,
  getOrder,
  checkSms,
  retry,
  cancel,
  getBalance,
  normalizeOtp,
  extractOtp,
  getLastError,
};