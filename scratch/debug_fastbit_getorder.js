/**
 * Debug script: Test Fastbit getOrder API to see actual response format.
 * 
 * Usage:
 *   node scratch/debug_fastbit_getorder.js <order_uuid>
 * 
 * This script calls the Fastbit API directly and logs the RAW response
 * so we can see the exact structure returned.
 */
const axios = require("axios");
const config = require("../config");

const apiKey = config.FASTBIT_API_KEY;
const baseUrl = config.FASTBIT_API_URL || "https://fastbit.co.id";

async function debugGetOrder(orderRef) {
  console.log("=== DEBUG FASTBIT GET ORDER ===");
  console.log("Base URL:", baseUrl);
  console.log("Order ref:", orderRef);
  console.log("");

  try {
    const url = `${baseUrl}/api/virtual-number/orders/${encodeURIComponent(orderRef)}`;
    console.log("Full URL:", url);
    console.log("");

    const response = await axios.get(url, {
      headers: {
        "X-API-KEY": apiKey,
        Accept: "application/json",
      },
      params: {
        check_sms: true,
        apikey: apiKey,
      },
      timeout: 30000,
    });

    console.log("HTTP Status:", response.status);
    console.log("");
    console.log("=== RAW RESPONSE DATA ===");
    console.log(JSON.stringify(response.data, null, 2));
    console.log("");

    // Now trace through the same parsing logic as fastbit.js
    const res = response.data;
    const order = res.data?.order || res.order || res.data || {};
    console.log("=== PARSED 'order' OBJECT ===");
    console.log(JSON.stringify(order, null, 2));
    console.log("");

    console.log("=== SMS FIELD ANALYSIS ===");
    console.log("typeof order.sms:", typeof order.sms);
    console.log("Array.isArray(order.sms):", Array.isArray(order.sms));
    console.log("order.sms value:", JSON.stringify(order.sms));
    console.log("");
    
    // Check all possible SMS fields
    const possibleSmsFields = ["sms", "sms_messages", "messages", "message", "otp", "otp_code", "code", "text", "sms_text", "sms_code"];
    console.log("=== CHECKING ALL POSSIBLE SMS FIELDS ===");
    for (const field of possibleSmsFields) {
      if (order[field] !== undefined) {
        console.log(`  order.${field}:`, JSON.stringify(order[field]));
      }
    }
    console.log("");

    // Check has_sms
    console.log("=== STATUS FLAGS ===");
    console.log("order.has_sms:", order.has_sms);
    console.log("order.status:", order.status);
    console.log("order.is_expired:", order.is_expired);
    console.log("");

    // What our current code would return as otp_code
    const smsList = Array.isArray(order.sms) ? order.sms : [];
    let smsText = "";
    let otpCode = "";
    if (smsList.length > 0) {
      const latestSms = smsList[smsList.length - 1];
      smsText = String(latestSms.text || latestSms.sms || latestSms.message || "");
      const compact = String(latestSms.code ?? "").trim().replace(/[\s-]/g, "");
      otpCode = /^\d{4,8}$/.test(compact) ? compact : "";
      if (!otpCode) {
        const match = smsText.match(/(?:^|\D)((?:\d[\s-]?){4,8})(?:\D|$)/);
        if (match) {
          const c = match[1].replace(/[\s-]/g, "");
          otpCode = /^\d{4,8}$/.test(c) ? c : "";
        }
      }
    }
    console.log("=== CURRENT PARSING RESULT ===");
    console.log("smsList.length:", smsList.length);
    console.log("smsText:", smsText);
    console.log("otpCode:", otpCode);
    console.log("");
    console.log(otpCode ? "✅ OTP WOULD BE DETECTED" : "❌ OTP WOULD NOT BE DETECTED");

  } catch (err) {
    console.error("Error:", err.response?.status, err.response?.data || err.message);
  }
}

// Also test listing recent orders to find an active one
async function listRecentOrders() {
  console.log("\n=== LISTING RECENT ORDERS ===");
  try {
    const response = await axios.get(`${baseUrl}/api/virtual-number/orders`, {
      headers: {
        "X-API-KEY": apiKey,
        Accept: "application/json",
      },
      params: { apikey: apiKey },
      timeout: 30000,
    });
    const data = response.data;
    const orders = data.data?.orders || data.orders || data.data || [];
    if (Array.isArray(orders)) {
      console.log(`Found ${orders.length} orders`);
      for (const o of orders.slice(0, 5)) {
        console.log(`  - ID: ${o.id || o.order_uuid}, Status: ${o.status}, has_sms: ${o.has_sms}, phone: ${o.number || o.phone}`);
      }
    } else {
      console.log("Orders response:", JSON.stringify(data, null, 2).slice(0, 2000));
    }
  } catch (err) {
    console.log("List orders error:", err.response?.status, err.response?.data || err.message);
  }
}

const orderRef = process.argv[2];
if (orderRef) {
  debugGetOrder(orderRef);
} else {
  console.log("No order UUID provided. Listing recent orders instead...");
  console.log("Usage: node scratch/debug_fastbit_getorder.js <order_uuid>");
  listRecentOrders();
}
