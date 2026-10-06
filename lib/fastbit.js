const axios = require("axios");
const config = require("../config");

let lastError = null;

function getApiKey() {
  return String(process.env.FASTBIT_API_KEY || config.FASTBIT_API_KEY || "").trim();
}

function getBaseUrl() {
  return String(
    process.env.FASTBIT_API_URL ||
    config.FASTBIT_API_URL ||
    "https://fastbit.tech"
  ).trim().replace(/\/+$/, "");
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
  if (value === null || value === undefined) return "";
  const compact = String(value).trim().replace(/[\s-]/g, "");
  return /^\d{4,8}$/.test(compact) ? compact : "";
}

function extractOtp(text) {
  const message = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();
  if (!message) return "";

  // 1. Check labelled patterns (e.g. "code is 123-456", "OTP: 123456", "Kode verifikasi 12345")
  const labelled = message.match(
    /(?:otp|one[-\s]?time|code|kode|pin|verification|verifikasi|passcode|security|kata sandi|sandi)[^\d]{0,40}((?:\d[\s-]?){4,8})(?!\d)/i
  );
  if (labelled) {
    const code = normalizeOtpCode(labelled[1]);
    if (code) return code;
  }

  // 2. Check for colon or equal separator (e.g. ": 123456", "= 123456")
  const colonMatch = message.match(/[:=]\s*((?:\d[\s-]?){4,8})(?!\d)/);
  if (colonMatch) {
    const code = normalizeOtpCode(colonMatch[1]);
    if (code) return code;
  }

  // 3. Fallback: all numeric chunks with 4 to 8 digits (skip 9+ digits like phone numbers)
  const tokens = [...message.matchAll(/(?:^|\D)((?:\d[\s-]?){4,8})(?=\D|$)/g)]
    .map((match) => normalizeOtpCode(match[1]))
    .filter(Boolean);

  if (tokens.length > 0) {
    return tokens[0];
  }

  return "";
}

function parseSmsItem(item) {
  if (!item) return { smsText: "", otpCode: "" };
  if (typeof item === "string") {
    const text = item.trim();
    return { smsText: text, otpCode: extractOtp(text) };
  }
  if (typeof item !== "object") return { smsText: "", otpCode: "" };

  const directCode = normalizeOtpCode(
    item.code || item.otp || item.otp_code || item.pin || item.val || item.token || item.verification_code
  );
  const text = String(
    item.text ||
    item.sms ||
    item.message ||
    item.content ||
    item.body ||
    item.full_text ||
    item.full_sms ||
    item.msg ||
    item.sms_text ||
    ""
  ).trim();
  const extracted = directCode || extractOtp(text);

  return {
    smsText: text || (directCode ? `Kode OTP: ${directCode}` : ""),
    otpCode: extracted,
  };
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
      params: { ...params, apikey: apiKey },
    };

    let response;
    if (method.toLowerCase() === "post") {
      response = await client.post(endpoint, data, configObj);
    } else {
      response = await client.get(endpoint, configObj);
    }

    const resData = response.data;
    if (resData && typeof resData === "object") {
      if (resData.status === "error" || resData.status === "failed") {
        lastError = resData.message || resData.msg || resData.error || "Penyedia menolak permintaan.";
        return resData; // Return resData anyway for inspection
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
    return responseData || null;
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
      id: String(item.id),
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

  return Array.from(grouped.values())
    .map((c) => {
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

  let firstResult = null;

  if (res.data?.results?.[0]) {
    firstResult = res.data.results[0];
  } else if (res.results?.[0]) {
    firstResult = res.results[0];
  } else if (res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
    firstResult = res.data;
  } else if (res.result && typeof res.result === "object") {
    firstResult = res.result;
  } else if (res.order || res.order_uuid || res.number) {
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

  const rawNumber =
    orderData.number ||
    orderData.phone ||
    orderData.phone_number ||
    orderData.formatted_number ||
    firstResult.number ||
    firstResult.phone ||
    "";
  const phoneNumber = String(
    typeof rawNumber === "object" && rawNumber !== null
      ? rawNumber.value || rawNumber.formatted || ""
      : rawNumber
  ).replace(/[^0-9+]/g, "");

  const price = Number(orderData.price || firstResult.price || 0);

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
    if (!lastError) lastError = "Penyedia tidak mengembalikan detail nomor yang valid.";
    return null;
  }

  return {
    order_id: orderUuid || orderId,
    order_uuid: orderUuid,
    fastbit_id: orderId,
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

  let smsText = "";
  let otpCode = "";
  let orderObj = {};
  let rawStatus = "waiting";

  // 1. Method A: Dedicated SMS polling endpoint /api/virtual-number/orders/{orderRef}/sms
  try {
    const smsRes = await request(`/api/virtual-number/orders/${encodeURIComponent(ref)}/sms`);
    if (smsRes) {
      const payload = smsRes.data || smsRes.sms || smsRes;
      if (Array.isArray(payload)) {
        for (const item of payload) {
          const parsed = parseSmsItem(item);
          if (parsed.otpCode) {
            otpCode = parsed.otpCode;
            smsText = parsed.smsText || smsText;
            break;
          } else if (parsed.smsText && !smsText) {
            smsText = parsed.smsText;
          }
        }
      } else if (payload && typeof payload === "object") {
        const parsed = parseSmsItem(payload);
        if (parsed.otpCode) otpCode = parsed.otpCode;
        if (parsed.smsText) smsText = parsed.smsText;
      } else if (typeof payload === "string" && payload.trim()) {
        smsText = payload.trim();
        otpCode = extractOtp(smsText);
      }
    }
  } catch (e) {}

  // 2. Method B: Full order details /api/virtual-number/orders/{orderUuid}?check_sms=true
  if (!otpCode) {
    try {
      const res = await request(`/api/virtual-number/orders/${encodeURIComponent(ref)}`, { check_sms: true });
      if (res) {
        orderObj = res.data?.order || res.order || res.data || res || {};
        rawStatus = String(orderObj.status || "").toLowerCase();

        // Check order.sms (array or object or string)
        if (Array.isArray(orderObj.sms) && orderObj.sms.length > 0) {
          for (let i = orderObj.sms.length - 1; i >= 0; i--) {
            const parsed = parseSmsItem(orderObj.sms[i]);
            if (parsed.otpCode) {
              otpCode = parsed.otpCode;
              smsText = parsed.smsText || smsText;
              break;
            } else if (parsed.smsText && !smsText) {
              smsText = parsed.smsText;
            }
          }
        } else if (orderObj.sms) {
          const parsed = parseSmsItem(orderObj.sms);
          if (parsed.otpCode) otpCode = parsed.otpCode;
          if (parsed.smsText) smsText = parsed.smsText;
        }

        // Check other fields on order
        if (!otpCode && Array.isArray(orderObj.sms_messages)) {
          for (const item of orderObj.sms_messages) {
            const parsed = parseSmsItem(item);
            if (parsed.otpCode) {
              otpCode = parsed.otpCode;
              smsText = parsed.smsText || smsText;
              break;
            }
          }
        }
        if (!otpCode && Array.isArray(orderObj.messages)) {
          for (const item of orderObj.messages) {
            const parsed = parseSmsItem(item);
            if (parsed.otpCode) {
              otpCode = parsed.otpCode;
              smsText = parsed.smsText || smsText;
              break;
            }
          }
        }
        if (!otpCode) {
          const parsed = parseSmsItem(orderObj);
          if (parsed.otpCode) otpCode = parsed.otpCode;
          if (parsed.smsText && !smsText) smsText = parsed.smsText;
        }
      }
    } catch (e) {}
  }

  // 3. Method C: Active orders list /api/virtual-number/orders/active
  if (!otpCode) {
    try {
      const activeRes = await request("/api/virtual-number/orders/active");
      const activeOrders = activeRes?.orders || activeRes?.data?.orders || [];
      if (Array.isArray(activeOrders)) {
        const found = activeOrders.find(
          (o) =>
            String(o.order_uuid || "").toLowerCase() === ref.toLowerCase() ||
            String(o.id || "") === ref ||
            (orderObj.number && o.number && String(o.number) === String(orderObj.number))
        );
        if (found) {
          orderObj = { ...orderObj, ...found };
          rawStatus = String(found.status || rawStatus).toLowerCase();
          if (Array.isArray(found.sms)) {
            for (let i = found.sms.length - 1; i >= 0; i--) {
              const parsed = parseSmsItem(found.sms[i]);
              if (parsed.otpCode) {
                otpCode = parsed.otpCode;
                smsText = parsed.smsText || smsText;
                break;
              }
            }
          } else if (found.sms) {
            const parsed = parseSmsItem(found.sms);
            if (parsed.otpCode) otpCode = parsed.otpCode;
            if (parsed.smsText) smsText = parsed.smsText;
          }
        }
      }
    } catch (e) {}
  }

  let status = "waiting";
  if (otpCode || orderObj.has_sms || ["completed", "received"].includes(rawStatus)) {
    status = "received";
  } else if (["canceled", "cancelled", "cancel", "failed", "expired"].includes(rawStatus)) {
    status = rawStatus;
  }

  return {
    order_id: String(orderObj.id || ref),
    order_uuid: String(orderObj.order_uuid || ref),
    number: String(orderObj.number || orderObj.formatted_number || ""),
    status: status,
    has_sms: Boolean(otpCode || orderObj.has_sms),
    sms: smsText,
    otp_code: otpCode,
    is_expired: Boolean(orderObj.is_expired),
    remaining_time: orderObj.remaining_time,
    raw: orderObj,
  };
}

async function cancelOrder(orderUuidOrRef) {
  const ref = String(orderUuidOrRef || "").trim();
  if (!ref) return null;
  let res = await request(`/api/virtual-number/orders/${encodeURIComponent(ref)}/cancel`, {}, "post");
  if (!res || res.success === false) {
    res = await request(`/api/virtual-number/orders/${encodeURIComponent(ref)}/cancel`, {}, "get");
  }
  if (!res) return null;
  return res.success === true || res.status === "success" || res.status === 200 || !res.error;
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

