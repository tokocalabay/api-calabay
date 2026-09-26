const axios = require("axios");
const config = require("../config");

const API = axios.create({
  baseURL: process.env.HERO_SMS_API_URL || config.HERO_SMS_API_URL || "https://hero-sms.com",
  timeout: 30_000,
  headers: { Accept: "application/json" },
});

let lastError = null;

function getApiKey() {
  return String(process.env.HERO_SMS_API_KEY || config.HERO_SMS_API_KEY || "").trim();
}

function getUsdToIdrRate() {
  const rate = Number(
    process.env.HERO_SMS_USD_TO_IDR ||
    config.HERO_SMS_USD_TO_IDR ||
    16000
  );
  return Number.isFinite(rate) && rate > 0 ? rate : 16000;
}

function toIdrPrice(usdPrice) {
  const value = Number(usdPrice);
  return Number.isFinite(value) && value >= 0
    ? Math.ceil(value * getUsdToIdrRate())
    : 0;
}

function errorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    return payload.trim() || null;
  }
  return payload.error?.message ||
    payload.message ||
    payload.msg ||
    payload.title ||
    payload.details ||
    (typeof payload.error === "string" ? payload.error : null) ||
    null;
}

function isErrorPayload(payload) {
  if (typeof payload === "string") {
    const value = payload.trim();
    // Hero SMS uses plain-text success responses for balance and cancel.
    // Other plain-text responses are provider errors (BAD_KEY, NO_NUMBERS, etc.).
    return Boolean(
      value &&
      !/^ACCESS_BALANCE:\s*-?\d+(?:\.\d+)?$/i.test(value) &&
      !/^ACCESS_CANCEL/i.test(value) &&
      !/^ACCESS_NUMBER/i.test(value) &&
      value.toUpperCase() !== "OK"
    );
  }
  return Boolean(
    payload?.status === "error" ||
    payload?.status === "failed" ||
    payload?.title ||
    payload?.details
  );
}

function apiError(name, error) {
  const responseData = error.response?.data;
  lastError = errorMessage(responseData) || error.message || "Layanan server 2 gagal memproses request.";
  console.error(`Server 2 ${name}:`, responseData || error.message);
}

async function request(name, params = {}, fallback = null) {
  const apiKey = getApiKey();
  if (!apiKey || /^(isi_api_key|your_api_key|change_me)/i.test(apiKey)) {
    lastError = "Token API server 2 belum diatur.";
    return fallback;
  }

  try {
    const response = await API.get("/stubs/handler_api.php", {
      params: { ...params, api_key: apiKey },
    });
    const payload = response.data;
    if (isErrorPayload(payload)) {
      lastError = errorMessage(payload) || "Layanan server 2 menolak request.";
      console.error(`Server 2 ${name}:`, payload);
      return fallback;
    }
    lastError = null;
    return payload;
  } catch (error) {
    apiError(name, error);
    return fallback;
  }
}

function getLastError() {
  return lastError;
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

async function getBalance() {
  const payload = await request("getBalance", { action: "getBalance" }, null);
  const match = String(payload || "").match(/^ACCESS_BALANCE:\s*(-?\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const balance = Number(match[1]);
  return {
    balance: Number.isFinite(balance) ? balance : null,
    saldo: match[1],
    formatted: match[1],
  };
}

let _countriesCache = null;
let _countriesCacheTime = 0;

async function getCachedCountries() {
  const now = Date.now();
  if (_countriesCache && now - _countriesCacheTime < 3600_000) {
    return _countriesCache;
  }
  const countries = await getCountries();
  if (countries.length) {
    _countriesCache = countries;
    _countriesCacheTime = now;
  }
  return countries;
}

async function getCountries() {
  const data = await request("getCountries", { action: "getCountries" }, []);
  const countries = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? Object.values(data)
      : [];
  return countries
    .map((country) => ({
        id: String(country?.id ?? "").trim(),
        name: String(country?.eng ?? country?.name ?? country?.rus ?? country?.id ?? "").trim(),
        visible: Number(country?.visible) !== 0,
        retry: Number(country?.retry) !== 0,
      }))
    .filter((country) => country.id && country.name && country.visible);
}

async function getCountriesForService(serviceId) {
  const sId = String(serviceId || "").trim();
  const [countries, pricesData] = await Promise.all([
    getCachedCountries(),
    request("getPrices", { action: "getPrices", service: sId }, {}),
  ]);
  const countryMap = new Map((countries || []).map((c) => [String(c.id), c.name]));
  const pricesObj = pricesData && typeof pricesData === "object" ? pricesData : {};
  const available = [];

  for (const [cId, svcObj] of Object.entries(pricesObj)) {
    if (!svcObj || typeof svcObj !== "object") continue;
    const data = svcObj[sId] || svcObj[sId.toLowerCase()] || (svcObj.cost !== undefined ? svcObj : null);
    if (data && Number(data.count || 0) > 0) {
      const cost = Number(data.cost || 0);
      available.push({
        id: String(cId),
        name: countryMap.get(String(cId)) || `Negara ${cId}`,
        cost: cost,
        price: cost,
        priceIdr: toIdrPrice(cost),
        stock: Number(data.count || 0),
        physicalStock: Number(data.physicalCount || 0),
      });
    }
  }

  available.sort((a, b) => {
    if (a.id === "6") return -1;
    if (b.id === "6") return 1;
    return a.name.localeCompare(b.name);
  });

  return available;
}

async function getServices(countryId = process.env.HERO_SMS_DEFAULT_COUNTRY_ID || "2") {
  const data = await request("getServices", {
    action: "getServicesList",
    country: String(countryId),
    lang: "en",
  }, null);
  return Array.isArray(data?.services)
    ? data.services.map((service) => ({
        id: String(service?.code ?? "").trim(),
        name: String(service?.name ?? service?.code ?? "").trim(),
      })).filter((service) => service.id && service.name)
    : [];
}

async function getServicesForCountry(countryId) {
  const data = await request("getServices", {
    action: "getServicesList",
    country: String(countryId),
    lang: "en",
  }, null);
  return Array.isArray(data?.services)
    ? data.services.map((service) => ({
        id: String(service?.code ?? "").trim(),
        name: String(service?.name ?? service?.code ?? "").trim(),
      })).filter((service) => service.id && service.name)
    : [];
}

async function getPrices(serviceId, countryId) {
  const data = await request("getPrices", {
    action: "getPrices",
    service: String(serviceId),
    country: String(countryId),
  }, []);
  const entries = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? Object.values(data)
      : [];
  return entries.flatMap((entry) => {
    const priceData = entry && typeof entry === "object"
      ? entry.cost !== undefined ? entry : Object.values(entry).find((value) => value && typeof value === "object")
      : null;
    const cost = Number(priceData?.cost);
    if (!Number.isFinite(cost) || cost < 0) return [];
    return [{
      price: cost,
      // Keep `price` in provider currency for getNumberV2.maxPrice.
      // Use `priceIdr` only for the bot's coin/display calculations.
      priceIdr: toIdrPrice(cost),
      stock: Number(priceData.count || 0),
      physicalStock: Number(priceData.physicalCount || 0),
    }];
  });
}

async function getOperators(countryId) {
  const data = await request("getOperators", {
    action: "getOperators",
    country: String(countryId),
  }, null);
  const operators = data?.countryOperators;
  if (!operators || typeof operators !== "object") return [];
  const names = [...new Set(Object.values(operators).flat().map((operator) => String(operator || "").trim()))];
  return names.filter(Boolean).map((name) => ({ id: name, name }));
}

async function createOrder(serviceIdOrParams, countryIdArg, operatorIdArg, maxPriceArg, referenceArg, phoneExceptionArg, verificationArg) {
  let serviceId, countryId, operatorId, maxPrice, reference, phoneException, verification, verificationType;

  if (typeof serviceIdOrParams === "object" && serviceIdOrParams !== null) {
    ({
      serviceId,
      countryId,
      operatorId,
      maxPrice,
      reference,
      phoneException = "",
      verification = false,
      verificationType = "sms",
    } = serviceIdOrParams);
  } else {
    serviceId = serviceIdOrParams;
    countryId = countryIdArg;
    operatorId = operatorIdArg;
    maxPrice = maxPriceArg;
    reference = referenceArg;
    phoneException = phoneExceptionArg || "";
    verification = Boolean(verificationArg);
    verificationType = verification ? "flashcall" : "sms";
  }

  const params = {
    action: "getNumberV2",
    service: String(serviceId),
    country: String(countryId),
    operator: String(operatorId || "any"),
    ref: String(reference || ""),
  };

  if (verification || verificationType === "flashcall" || verificationType === "call") {
    params.verification = "true";
  }

  if (Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0) {
    params.maxPrice = Number(maxPrice);
    params.fixedPrice = "true";
  }
  if (phoneException) params.phoneException = String(phoneException);

  const data = await request("createOrder", params, null);
  if (!data || typeof data !== "object" || !data.activationId || !data.phoneNumber) {
    if (!lastError) lastError = "Penyedia tidak mengembalikan data order yang lengkap.";
    return null;
  }
  return {
    ...data,
    order_id: String(data.activationId),
    phone_number: String(data.phoneNumber),
    phone: String(data.phoneNumber),
    price: Number(data.activationCost),
    expired_at: data.activationEndTime ? Date.parse(data.activationEndTime) : 0,
    verification_type: verification || verificationType === "flashcall" ? "flashcall" : "sms",
  };
}

async function getOrder(orderId) {
  const data = await request("getOrder", {
    action: "getStatusV2",
    id: String(orderId),
  }, null);
  if (!data || typeof data !== "object") return null;

  const sms = data.sms && typeof data.sms === "object" ? data.sms : {};
  const call = data.call && typeof data.call === "object" ? data.call : {};
  const smsText = String(sms.text ?? "");
  const callCode = normalizeOtpCode(call.code) ||
    (call.number ? normalizeOtpCode(String(call.number).slice(-4)) : "") ||
    (call.phone ? normalizeOtpCode(String(call.phone).slice(-4)) : "") ||
    extractOtp(call.text);
  const otpCode = normalizeOtpCode(sms.code) || extractOtp(smsText) || callCode;
  const isCallOtp = Boolean(!sms.code && !extractOtp(smsText) && callCode);
  const displayText = smsText || (call.code ? `Panggilan FlashCall: ${call.code}` : (call.number ? `Panggilan dari: ${call.number}` : ""));

  return {
    ...data,
    order_id: String(orderId),
    status: otpCode ? "received" : (data.status === 8 || data.status === "8" ? "cancelled" : "waiting"),
    sms: displayText,
    otp_msg: displayText,
    otp_code: otpCode,
    is_call: isCallOtp,
  };
}

async function cancelOrder(orderId) {
  let payload = await request("cancelOrder", {
    action: "setStatus",
    status: "8",
    id: String(orderId),
  }, null);
  const str1 = String(payload || "").trim().toUpperCase();
  if (str1 === "ACCESS_CANCEL" || str1 === "OK") {
    return payload;
  }
  payload = await request("cancelOrder", {
    action: "cancelActivation",
    id: String(orderId),
  }, null);
  const str2 = String(payload || "").trim().toUpperCase();
  return (str2 === "OK" || str2 === "ACCESS_CANCEL") ? payload : null;
}

module.exports = {
  getBalance,
  getServices,
  getServicesForCountry,
  getCountries,
  getCountriesForService,
  getPrices,
  toIdrPrice,
  getOperators,
  createOrder,
  getOrder,
  cancelOrder,
  getLastError,
  extractOtp,
};