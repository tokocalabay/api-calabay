const axios = require("axios");
const config = require("../config");

let lastError = null;

function getApiKey() {
  return String(process.env.FASTBIT_API_KEY || config.FASTBIT_API_KEY || "").trim();
}

function getBaseUrl() {
  return String(process.env.FASTBIT_API_URL || config.FASTBIT_API_URL || "https://fastbit.co.id")
    .trim()
    .replace(/\/+$/, "");
}

function getClient() {
  const apiKey = getApiKey();
  return axios.create({
    baseURL: getBaseUrl(),
    timeout: 30_000,
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
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

async function request(endpoint, params = {}, method = "get", data = null) {
  const apiKey = getApiKey();
  if (!apiKey || /^(isi_api_key|your_api_key|change_me)/i.test(apiKey)) {
    lastError = "API Key belum diatur di config.js.";
    return null;
  }

  try {
    const client = getClient();
    const configObj = {
      params: { ...params, apikey: apiKey }, // fallback via query string as well
    };

    let response;
    if (method.toLowerCase() === "post") {
      response = await client.post(endpoint, data, configObj);
    } else {
      response = await client.get(endpoint, configObj);
    }

    const resData = response.data;
    if (resData && typeof resData === "object") {
      if (resData.success === false || resData.status === "error" || resData.status === "failed") {
        lastError = resData.message || resData.msg || resData.error || "Penyedia menolak permintaan.";
        console.error("[FastBit API Error]:", endpoint, resData);
        return null;
      }
    }

    lastError = null;
    return resData;
  } catch (error) {
    const responseData = error.response?.data;
    lastError =
      responseData?.message ||
      responseData?.msg ||
      responseData?.error ||
      error.message ||
      "Gagal menghubungi server penyedia.";
    console.error("[FastBit Request Exception]:", endpoint, responseData || error.message);
    return null;
  }
}

async function getBalance() {
  const res = await request("/api/profile");
  if (!res) return null;
  const user = res.user || res.data?.user || {};
  const rawBalance = user.active_balance;
  let balance = null;
  if (typeof rawBalance === "number") {
    balance = rawBalance;
  } else if (typeof rawBalance === "string") {
    balance = Number(rawBalance.replace(/[^0-9.-]/g, "")) || 0;
  }
  return {
    balance: Number.isFinite(balance) ? balance : 0,
    formatted: `Rp ${(balance || 0).toLocaleString("id-ID")}`,
    name: user.name || user.username || "User",
    currency: user.currency_code || "IDR",
    raw: user,
  };
}

async function getServices(search = "") {
  const params = {};
  if (search && String(search).trim()) {
    params.q = String(search).trim();
  }
  const res = await request("/api/services", params);
  if (!res) return [];
  const rawList = Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : [];
  return rawList
    .map((s) => ({
      id: String(s.id),
      name: String(s.text || s.name || `Service ${s.id}`).trim(),
      description: s.description || null,
      icon: s.icon || null,
    }))
    .filter((s) => s.id && s.name);
}

async function getCountriesForService(serviceId) {
  const res = await request("/api/services/countries", { application_id: serviceId });
  if (!res) return [];
  const rawCountries = Array.isArray(res.countries)
    ? res.countries
    : Array.isArray(res.data?.countries)
    ? res.data.countries
    : [];

  const grouped = new Map();

  for (const item of rawCountries) {
    if (!item || !item.can_order) continue;
    const countryName = String(item.name || item.iso || "Unknown").trim();
    const iso = String(item.iso || countryName).trim().toUpperCase();
    const priceNum = Number(item.price);
    const stockNum = Number(item.stock) || 0;
    if (!Number.isFinite(priceNum) || priceNum <= 0) continue;

    const offer = {
      id: String(item.id), // otp_service_id
      operator: String(item.operator || "any").trim(),
      price: priceNum,
      priceFormatted: item.price_formatted || `Rp ${priceNum.toLocaleString("id-ID")}`,
      stock: stockNum,
      providerName: item.provider_name || "server_1",
      deliveryPercent: item.delivery_percent || null,
    };

    if (!grouped.has(countryName)) {
      grouped.set(countryName, {
        id: iso,
        name: countryName,
        iso: iso,
        prefix: item.prefix || "",
        minPrice: priceNum,
        totalStock: stockNum,
        offers: [offer],
      });
    } else {
      const existing = grouped.get(countryName);
      existing.offers.push(offer);
      existing.totalStock += stockNum;
      if (priceNum < existing.minPrice) {
        existing.minPrice = priceNum;
      }
    }
  }

  // Format into list sorted by stock descending, minPrice ascending
  return Array.from(grouped.values())
    .map((c) => {
      // Sort offers inside country: lowest price first
      c.offers.sort((a, b) => a.price - b.price);
      return {
        id: c.id,
        name: c.name,
        iso: c.iso,
        prefix: c.prefix,
        price: c.minPrice,
        priceIdr: c.minPrice,
        stock: c.totalStock,
        offers: c.offers,
      };
    })
    .sort((a, b) => {
      // Prioritize Indonesia at the top if present
      if (a.iso === "ID" || a.name.toLowerCase().includes("indonesia")) return -1;
      if (b.iso === "ID" || b.name.toLowerCase().includes("indonesia")) return 1;
      return b.stock - a.stock;
    });
}

async function createOrder({ otpServiceId, quantity = 1 }) {
  const res = await request("/api/order-v2", {
    otp_service_id: otpServiceId,
    quantity: Math.max(1, Math.min(3, Number(quantity) || 1)),
  });

  if (!res) return null;

  // Debug: log full response to understand the actual structure
  console.log("[FastBit createOrder] Raw response:", JSON.stringify(res, null, 2));

  // Try multiple response structures the API might return
  let firstResult = null;

  // Structure 1: { data: { results: [{ order_uuid, order: {...} }] } }
  if (res.data?.results?.[0]) {
    firstResult = res.data.results[0];
  }
  // Structure 2: { results: [{ order_uuid, order: {...} }] }
  else if (res.results?.[0]) {
    firstResult = res.results[0];
  }
  // Structure 3: { data: { order_uuid, order: {...} } }  or { data: { order_uuid, number, ... } }
  else if (res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
    firstResult = res.data;
  }
  // Structure 4: { result: { ... } }
  else if (res.result && typeof res.result === "object") {
    firstResult = res.result;
  }
  // Structure 5: { order: { ... } } or { order_uuid, ... } — direct response
  else if (res.order || res.order_uuid || res.number) {
    firstResult = res;
  }

  if (!firstResult || firstResult.success === false) {
    if (!lastError) {
      lastError = firstResult?.message || res.message || "Penyedia menolak pembuatan order.";
    }
    return null;
  }

  const orderData = firstResult.order || firstResult;
  const orderUuid = String(
    firstResult.order_uuid || orderData.order_uuid || orderData.uuid || orderData.id || ""
  );
  const orderId = String(orderData.id || orderUuid);

  // number can be an object { value, formatted } or a plain string
  const rawNumber = orderData.number || orderData.phone || orderData.phone_number ||
    orderData.formatted_number || firstResult.number || firstResult.phone || "";
  const phoneNumber = String(
    (typeof rawNumber === "object" && rawNumber !== null)
      ? (rawNumber.value || rawNumber.formatted || "")
      : rawNumber
  ).replace(/[^0-9+]/g, "");

  const price = Number(orderData.price || firstResult.price || 0);

  // expires_at can be an ISO date string or remaining_time can be seconds
  let expiredAt;
  const rawExpiry = orderData.expires_at || firstResult.expires_at;
  if (rawExpiry && typeof rawExpiry === "string" && rawExpiry.includes("T")) {
    expiredAt = new Date(rawExpiry).getTime();
  } else {
    const remainingSeconds = Number(orderData.remaining_time || firstResult.remaining_time || 1200);
    expiredAt = Date.now() + remainingSeconds * 1000;
  }
  const remainingSeconds = Math.max(0, Math.round((expiredAt - Date.now()) / 1000));

  if (!orderUuid || !phoneNumber) {
    console.error("[FastBit createOrder] Missing order_uuid or phone. Parsed:", {
      orderUuid, phoneNumber, firstResult: JSON.stringify(firstResult),
    });
    if (!lastError) lastError = "Penyedia tidak mengembalikan detail nomor yang valid.";
    return null;
  }

  return {
    order_id: orderId,
    order_uuid: orderUuid,
    phone_number: phoneNumber,
    price: price,
    expired_at: expiredAt,
    remaining_time: remainingSeconds,
    raw: orderData,
  };
}

async function getOrder(orderUuidOrRef) {
  const ref = String(orderUuidOrRef || "").trim();
  if (!ref) return null;

  const res = await request(`/api/virtual-number/orders/${encodeURIComponent(ref)}`, { check_sms: true });
  if (!res) return null;

  const order = res.data?.order || res.order || res.data || {};
  const smsList = Array.isArray(order.sms) ? order.sms : [];
  let smsText = "";
  let otpCode = "";

  if (smsList.length > 0) {
    const latestSms = smsList[smsList.length - 1];
    smsText = String(latestSms.text || latestSms.sms || latestSms.message || "");
    otpCode = normalizeOtpCode(latestSms.code) || extractOtp(smsText);
  }

  const rawStatus = String(order.status || "").toLowerCase();
  let status = "waiting";
  if (otpCode || order.has_sms || ["completed", "received"].includes(rawStatus)) {
    status = "received";
  } else if (["canceled", "cancelled", "cancel", "failed", "expired"].includes(rawStatus)) {
    status = rawStatus;
  }

  return {
    order_id: String(order.id || ref),
    order_uuid: String(order.order_uuid || ref),
    number: String(order.number || order.formatted_number || ""),
    status: status,
    has_sms: Boolean(otpCode || order.has_sms),
    sms: smsText,
    otp_code: otpCode,
    is_expired: Boolean(order.is_expired),
    remaining_time: order.remaining_time,
    raw: order,
  };
}

async function cancelOrder(orderUuidOrRef) {
  const ref = String(orderUuidOrRef || "").trim();
  if (!ref) return null;
  const res = await request(`/api/virtual-number/orders/${encodeURIComponent(ref)}/cancel`);
  if (!res) return null;
  return res.success === true || res.status === "success" || res.status === 200;
}

async function finishOrder(orderUuidOrRef) {
  const ref = String(orderUuidOrRef || "").trim();
  if (!ref) return false;
  const res = await request(`/api/virtual-number/orders/${encodeURIComponent(ref)}/finish`);
  return res && (res.success === true || res.status === "success");
}

module.exports = {
  getBalance,
  getServices,
  getCountriesForService,
  createOrder,
  getOrder,
  cancelOrder,
  finishOrder,
  extractOtp,
  normalizeOtpCode,
  getLastError,
  setLastError,
};
