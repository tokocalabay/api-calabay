const axios = require("axios");
const config = require("../config");

const API = axios.create({
  baseURL: process.env.OTPCEPAT_API_URL || config.OTPCEPAT_API_URL || "https://otpcepat.org",
  timeout: 30_000,
  headers: { Accept: "application/json" },
});

let lastError = null;
let lastCreateOrderResponse = null;

function getApiKey() {
  return String(process.env.OTPCEPAT_API_KEY || config.OTPCEPAT_API_KEY || "").trim();
}

function isSuccessStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return value === true ||
    value === 1 ||
    normalized === "true" ||
    normalized === "success" ||
    normalized === "ok" ||
    normalized === "200";
}

function errorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    try {
      return errorMessage(JSON.parse(payload));
    } catch {
      return payload.trim() || null;
    }
  }
  return payload.msg || payload.message || payload.error || payload.data?.message || null;
}

function requestError(name, error) {
  const payload = error.response?.data;
  lastError = errorMessage(payload) || error.message || "OTP Cepat gagal memproses request.";
  console.error(`OTP Cepat ${name}:`, payload || error.message);
}

async function request(name, action, params = {}, fallback = null) {
  const apiKey = getApiKey();
  if (!apiKey || /^(isi_api_key|your_api_key|change_me)/i.test(apiKey)) {
    lastError = "OTPCEPAT_API_KEY belum diisi dengan API key OTP Cepat yang valid.";
    return fallback;
  }

  try {
    const response = await API.get("/api/handler_api.php", {
      params: { api_key: apiKey, action, ...params },
    });
    const payload = typeof response.data === "string"
      ? (() => {
          try { return JSON.parse(response.data); } catch { return response.data; }
        })()
      : response.data;
    if (!isSuccessStatus(payload?.status)) {
      lastError = errorMessage(payload) || `OTP Cepat menolak action ${action}.`;
      console.error(`OTP Cepat ${name}:`, payload);
      return fallback;
    }
    lastError = null;
    // Most endpoints return their result in `data`, while set_status returns
    // `{ status: true, msg: "success" }` without a data property.
    return payload.data === undefined ? payload : payload.data;
  } catch (error) {
    requestError(name, error);
    return fallback;
  }
}

function normalizeBalance(data) {
  if (!data || typeof data !== "object") return null;
  const rawBalance = data.saldo ?? data.balance ?? data.saldo_amount;
  const balance = Number(rawBalance);
  return {
    email: String(data.email || ""),
    saldo: String(rawBalance ?? ""),
    balance: Number.isFinite(balance) ? balance : null,
  };
}

function unwrapData(value) {
  if (typeof value === "string") {
    try {
      return unwrapData(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== "object") return value;
  if (
    value.order_id !== undefined ||
    value.orderId !== undefined ||
    value.activationId !== undefined ||
    value.number !== undefined ||
    value.phone !== undefined ||
    value.phone_number !== undefined ||
    value.phoneNumber !== undefined
  ) {
    return value;
  }
  for (const key of ["data", "result", "order", "response"]) {
    if (value[key] !== undefined) {
      const nested = unwrapData(value[key]);
      if (nested && typeof nested === "object") return nested;
    }
  }
  return value;
}

function normalizeOrder(value, fallbackOrderId = "") {
  const data = unwrapData(value);
  if (!data || typeof data !== "object") return null;

  const orderId = String(
    data.order_id ??
    data.orderId ??
    data.activationId ??
    data.activation_id ??
    data.id ??
    fallbackOrderId
  ).trim();
  const number = String(
    data.number ??
    data.phone ??
    data.phone_number ??
    data.phoneNumber ??
    data.msisdn ??
    ""
  ).trim();
  if (!orderId || !number) return null;

  return {
    ...data,
    order_id: orderId,
    number,
    status: normalizeOrderStatus(data.status ?? data.state ?? ""),
    expired_time: String(data.expired_time ?? data.expiredAt ?? data.expires_at ?? ""),
  };
}

function normalizeOrderStatus(value) {
  const status = String(value ?? "").trim();
  const normalized = status.toLowerCase();
  if (/(cancel|canceled|cancelled)/.test(normalized)) return "canceled";
  if (/(expir|timeout)/.test(normalized)) return "expired";
  if (/(fail|error|reject)/.test(normalized)) return "failed";
  if (/(finish|finished|complete|completed|done|success)/.test(normalized)) return "finished";
  if (/(wait|pending|process|รับข้อความ)/.test(normalized)) return "waiting";
  return status;
}

async function getBalance() {
  return normalizeBalance(await request("getBalance", "getBalance", {}, null));
}

async function getCountries() {
  const data = await request("getCountries", "getCountries", {}, []);
  return Array.isArray(data)
    ? data.map((country) => ({
        id: String(country?.countryID ?? country?.country_id ?? ""),
        name: String(country?.countryName ?? country?.country_name ?? country?.name ?? ""),
      })).filter((country) => country.id && country.name)
    : [];
}

async function getOperators(countryId) {
  const data = await request("getOperators", "getOperators", {
    country_id: String(countryId),
  }, []);

  return Array.isArray(data)
    ? data.map((operator) => {
        if (operator && typeof operator === "object") {
          const id = operator.operatorID ?? operator.operator_id ?? operator.id ?? operator.name;
          return { id: String(id ?? ""), name: String(operator.operatorName ?? operator.operator_name ?? operator.name ?? id ?? "") };
        }
        return { id: String(operator ?? ""), name: String(operator ?? "") };
      }).filter((operator) => operator.id && operator.name)
    : [];
}

async function getServices(countryId) {
  const data = await request("getServices", "getServices", {
    country_id: String(countryId),
  }, []);

  return Array.isArray(data)
    ? data.map((service) => ({
        id: String(service?.serviceID ?? service?.service_id ?? service?.id ?? ""),
        name: String(service?.serviceName ?? service?.service_name ?? service?.name ?? ""),
        price: Number(service?.price),
      })).filter((service) =>
        service.id &&
        service.name &&
        Number.isFinite(service.price) &&
        service.price >= 0
      )
    : [];
}

async function createOrder(operatorId, serviceId, countryId) {
  lastCreateOrderResponse = null;
  lastCreateOrderOutcome = "unknown";
  const apiKey = getApiKey();
  if (!apiKey || /^(isi_api_key|your_api_key|change_me)/i.test(apiKey)) {
    lastError = "OTPCEPAT_API_KEY belum diisi dengan API key OTP Cepat yang valid.";
    return null;
  }

  try {
    // OTP Cepat's real get_order response is:
    // { status: true, data: { order_id, number, status, expired_time } }
    // Read that contract directly so a successful provider response is never
    // lost by the generic endpoint parser.
    const response = await API.get("/api/handler_api.php", {
      params: {
        api_key: apiKey,
        action: "get_order",
        operator_id: String(operatorId),
        service_id: String(serviceId),
        country_id: String(countryId),
      },
    });
    const payload = typeof response.data === "string"
      ? (() => {
          try { return JSON.parse(response.data); } catch { return response.data; }
        })()
      : response.data;
    // Keep the exact provider response available to index.js. This is a
    // recovery path for deployments where an older adapter logs the payload
    // correctly but returns null to its caller.
    lastCreateOrderResponse = payload;
    const data = normalizeOrder(payload);
    const status = payload && typeof payload === "object" ? payload.status : null;
    if (status === false || String(status || "").toLowerCase() === "error") {
      lastError = errorMessage(payload) || "OTP Cepat menolak order.";
      console.error("OTP Cepat createOrder response:", payload);
      lastCreateOrderOutcome = "rejected";
      return null;
    }
    if (!data) {
      lastError = isSuccessStatus(status)
        ? "OTP Cepat mengembalikan respons sukses tanpa detail order."
        : errorMessage(payload) || "OTP Cepat menolak order.";
      console.error("OTP Cepat createOrder missing fields:", payload);
      lastCreateOrderOutcome = isSuccessStatus(status) ? "unknown" : "rejected";
      return null;
    }

    lastError = null;
    lastCreateOrderOutcome = "success";
    const price = Number(data.price ?? data.amount);
    return {
      ...data,
      order_id: data.order_id,
      number: data.number,
      price: Number.isFinite(price) ? price : null,
    };
  } catch (error) {
    lastCreateOrderOutcome = "unknown";
    requestError("createOrder", error);
    return null;
  }
}

function getLastCreateOrderResponse() {
  return lastCreateOrderResponse;
}

let lastCreateOrderOutcome = "unknown";

function getLastCreateOrderOutcome() {
  return lastCreateOrderOutcome;
}

function normalizeOtpCode(value) {
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
    const code = normalizeOtpCode(labelled[1]);
    if (code) return code;
  }

  const numericTokens = [...message.matchAll(/(?:^|\D)((?:\d[\s-]?){4,8})(?=\D|$)/g)]
    .map((match) => normalizeOtpCode(match[1]))
    .filter(Boolean);
  return numericTokens.length === 1 ? numericTokens[0] : "";
}

async function getOrder(orderId) {
  const response = await request("getOrder", "get_status", {
    order_id: String(orderId),
  }, null);
  const data = unwrapData(response);
  if (!data || typeof data !== "object") return null;

  const sms = String(
    data.sms ??
    data.otp_msg ??
    data.sms_text ??
    data.smsText ??
    data.message ??
    data.text ??
    ""
  );
  const status = normalizeOrderStatus(data.status ?? data.state ?? data.order_status ?? "");
  return {
    ...data,
    order_id: String(data.order_id ?? orderId),
    number: String(data.number ?? data.phone ?? data.phone_number ?? data.phoneNumber ?? ""),
    serviceName: String(data.serviceName ?? data.service_name ?? ""),
    status,
    sms,
    otp_msg: sms,
    otp_code: normalizeOtpCode(data.otp_code) ||
      normalizeOtpCode(data.otpCode) ||
      normalizeOtpCode(data.code) ||
      extractOtp(sms),
  };
}

function statusCode(status) {
  const normalized = String(status || "").toLowerCase();
  return {
    cancel: 2,
    canceled: 2,
    cancelled: 2,
    resend: 3,
    finish: 4,
    finished: 4,
    done: 4,
  }[normalized] || null;
}

async function setOrderStatus(orderId, status) {
  const code = statusCode(status);
  if (!code) {
    lastError = "Status OTP Cepat tidak valid. Gunakan cancel, resend, atau finish.";
    return null;
  }

  return request("setOrderStatus", "set_status", {
    order_id: String(orderId),
    status: String(code),
  }, null);
}

async function cancelOrder(orderId) {
  return setOrderStatus(orderId, "cancel");
}

async function finishOrder(orderId) {
  return setOrderStatus(orderId, "finish");
}

function getLastError() {
  return lastError;
}

module.exports = {
  getBalance,
  getCountries,
  getOperators,
  getServices,
  createOrder,
  getLastCreateOrderResponse,
  getOrder,
  setOrderStatus,
  cancelOrder,
  finishOrder,
  getLastError,
  getLastCreateOrderResponse,
  getLastCreateOrderOutcome,
  normalizeOrder,
  extractOtp,
};