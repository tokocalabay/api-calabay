const axios = require("axios");
const config = require("../config");

let lastError = null;

function getApiKey() {
  return String(process.env.RUMAHOTP_API_KEY || config.RUMAHOTP_API_KEY || "").trim();
}

function getBaseUrl() {
  return String(process.env.RUMAHOTP_API_URL || config.RUMAHOTP_API_URL || "https://www.rumahotp.io/api").trim().replace(/\/+$/, "");
}

function getClient() {
  const apiKey = getApiKey();
  return axios.create({
    baseURL: getBaseUrl(),
    timeout: 20_000,
    headers: {
      "x-apikey": apiKey,
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    },
  });
}

function normalizeOtpCode(value) {
  const compact = String(value ?? "").trim().replace(/[\s-]/g, "");
  return /^\d{4,8}$/.test(compact) ? compact : "";
}

function extractOtp(text) {
  const message = String(text || "").trim();
  if (!message) return "";
  const labelled = message.match(
    /(?:otp|code|kode|pin|verification|verifikasi)[^\d]{0,24}((?:\d[\s-]?){4,8})(?!\d)/i
  );
  if (labelled) {
    const code = normalizeOtpCode(labelled[1]);
    if (code) return code;
  }
  const numeric = message.match(/(?:^|\D)((?:\d[\s-]?){4,8})(?:\D|$)/);
  return numeric ? normalizeOtpCode(numeric[1]) : "";
}

function getLastError() {
  return lastError;
}

function setLastError(msg) {
  lastError = msg;
}

async function request(endpoint, params = {}) {
  const apiKey = getApiKey();
  if (!apiKey || /^(isi_api_key|your_api_key|change_me)/i.test(apiKey)) {
    lastError = "API Key belum dikonfigurasi di config.js.";
    return null;
  }

  try {
    const client = getClient();
    const response = await client.get(endpoint, { params });
    const resData = response.data;

    if (resData && typeof resData === "object") {
      if (resData.success === false || resData.status === false || resData.status === "error" || resData.status === "failed") {
        lastError = resData.error?.message || resData.msg || resData.message || resData.error || "Penyedia menolak request.";
        console.error("[RumahOTP API Error]:", endpoint, resData);
        return null;
      }
    }

    lastError = null;
    return resData;
  } catch (error) {
    const responseData = error.response?.data;
    lastError = responseData?.error?.message || responseData?.msg || responseData?.message || responseData?.error || error.message || "Gagal menghubungi server penyedia.";
    console.error("[RumahOTP Request Exception]:", endpoint, responseData || error.message);
    return null;
  }
}

async function getBalance() {
  const res = await request("/v1/user/balance");
  if (!res) return null;
  const rawBalance = res.data?.balance ?? res.balance ?? res.data;
  const balance = Number(rawBalance);
  return {
    balance: Number.isFinite(balance) ? balance : null,
    formatted: res.data?.formated || (Number.isFinite(balance) ? `Rp${balance.toLocaleString("id-ID")}` : String(rawBalance || 0)),
    username: res.data?.username,
    data: res.data,
  };
}

async function getServices() {
  const res = await request("/v2/services");
  if (!res) return [];
  const rawList = Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : [];
  return rawList.map((svc) => ({
    id: String(svc.service_code ?? svc.id ?? svc.code ?? "").trim(),
    name: String(svc.service_name ?? svc.name ?? svc.service ?? svc.id ?? "").trim(),
    image: svc.service_img || null,
  })).filter((svc) => svc.id && svc.name);
}

async function getCountries(serviceId) {
  const res = await request("/v2/countries", { service_id: String(serviceId) });
  if (!res) return [];
  const rawList = Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : [];
  return rawList.map((c) => {
    const available = (c.pricelist || [])
      .filter((p) => p.available && Number(p.stock) > 0)
      .sort((a, b) => Number(a.price) - Number(b.price));
    const chosen = available[0] || c.pricelist?.[0] || {};
    return {
      id: String(c.number_id ?? c.id ?? "").trim(),
      name: String(c.name ?? c.country_name ?? c.id ?? "").trim(),
      numberId: c.number_id ?? c.id,
      providerId: String(chosen.provider_id || "0"),
      price: Number(chosen.price || c.price || 0),
      stock: Number(chosen.stock || c.stock_total || 0),
      prefix: c.prefix || "",
    };
  }).filter((c) => c.id && c.name && c.price > 0);
}

async function getOperators(country, providerId) {
  const res = await request("/v2/operators", {
    country: String(country),
    provider_id: String(providerId || "0"),
  });
  if (!res) return [];
  const rawList = Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : [];
  return rawList.map((op) => ({
    id: String(op.id ?? op.operator_id ?? op.name ?? "").trim(),
    name: String(op.name ?? op.operator_name ?? op.id ?? "").trim(),
  })).filter((op) => op.id && op.name);
}

async function buyNumber({ numberId, providerId, operatorId }) {
  const res = await request("/v2/orders", {
    number_id: String(numberId),
    provider_id: String(providerId || "0"),
    operator_id: String(operatorId || "0"),
  });
  if (!res) return null;

  const data = res.data || res;
  const orderId = String(data.order_id ?? data.id ?? "");
  const phone = String(data.phone_number ?? data.phone ?? data.number ?? "").replace(/\s+/g, "");
  const price = Number(data.price ?? data.cost ?? 0);

  if (!orderId || !phone) {
    if (!lastError) lastError = "Penyedia tidak mengembalikan data order yang valid.";
    return null;
  }

  return {
    order_id: orderId,
    phone: phone,
    price: price,
    raw: data,
  };
}

async function getOrder(orderId) {
  const res = await request("/v1/orders/get_status", { order_id: String(orderId) });
  if (!res) return null;

  const data = res.data || res;
  const sms = String(data.otp_msg ?? data.sms ?? data.message ?? data.otp ?? data.msg ?? "");
  const otpCode = normalizeOtpCode(data.otp_code ?? data.otp) || extractOtp(sms);
  const rawStatus = String(data.status ?? "").toLowerCase();

  let normalizedStatus = "waiting";
  if (otpCode || ["completed", "received"].includes(rawStatus)) {
    normalizedStatus = "received";
  } else if (["canceled", "cancelled", "cancel", "expired", "failed", "error"].includes(rawStatus)) {
    normalizedStatus = rawStatus;
  }

  return {
    order_id: String(orderId),
    status: normalizedStatus,
    sms: sms,
    otp_code: otpCode,
    raw: data,
  };
}

async function cancelOrder(orderId) {
  const res = await request("/v1/orders/set_status", {
    order_id: String(orderId),
    status: "cancel",
  });
  if (!res) return false;
  return res.success === true || res.status === true || res.data?.status === "cancel";
}

module.exports = {
  getBalance,
  getServices,
  getCountries,
  getOperators,
  buyNumber,
  getOrder,
  cancelOrder,
  extractOtp,
  normalizeOtpCode,
  getLastError,
  setLastError,
};
