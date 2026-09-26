const dns = require("dns");
try { dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]); } catch (_) {}

const { Telegraf, Markup } = require("telegraf");
const config = require("./config");
const db     = require("./db");
const wahub  = require("./lib/wahub");
const engineunicorn = require("./lib/engineunicorn");
const wahubSessionDb = require("./wahub-session-db");
const otpcepat = require("./lib/otpcepat");
const herosms = require("./lib/herosms");
const rumahotp = require("./lib/rumahotp");
const fastbit = require("./lib/fastbit");
const { createPayment, cekPaid, cancelQris } = require("./lib/payment");
const { createZip } = require("./lib/zip");
const apiKeys = require("./lib/api-keys");
const { createApiServer } = require("./api-server");
const QRCode = require("qrcode");
const fs     = require("fs");
const path   = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const bot = new Telegraf(config.BOT_TOKEN);
const execFileAsync = promisify(execFile);
const OTP_WAIT_MS = 20 * 60 * 1000;

bot.catch((err, ctx) => {
  const errMsg = err?.message || String(err);
  if (
    /query is too old|message is not modified|message to edit not found|chat not found|bot was blocked/i.test(errMsg)
  ) {
    return;
  }
  console.error(`[TELEGRAF ERROR] ${ctx?.updateType || "unknown"}:`, errMsg);
});

// ── Helpers ───────────────────────────────────────────────
const isOwner = (ctx) => String(ctx.from?.id) === String(config.OWNER_ID);

function rupiah(n) {
  return `Rp${Number(n || 0).toLocaleString("id-ID")}`;
}

function usd(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "$0";
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function getWaktu() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", dateStyle: "full", timeStyle: "short"
  });
}

function escapeHTML(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function copyOtpButton(otp) {
  return { text: "📋 Salin OTP", copy_text: { text: String(otp) } };
}

function copyPhoneButton(phone) {
  return { text: "📋 Salin Nomor", copy_text: { text: String(phone) } };
}

function wahubExpiryMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + OTP_WAIT_MS;
  if (numeric <= 86400) return Date.now() + numeric * 1000;
  const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return ms > Date.now() ? ms : Date.now() + OTP_WAIT_MS;
}

function isWahubCancelSuccess(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") {
    const state = value.trim().toLowerCase();
    if (/^(1|200|ok|true|success|succeed|sukses|berhasil)$/.test(state)) return true;
    return /(cancel+ed?|dibatal|berhasil|sukses)/.test(state);
  }
  if (typeof value !== "object") return Boolean(value);

  if (value.ok === false || value.success === false || value.status === false) return false;

  for (const key of ["data", "result", "response"]) {
    if (value[key] !== undefined && isWahubCancelSuccess(value[key])) return true;
  }

  if (
    value.ok === true ||
    value.success === true ||
    value.cancelled === true ||
    value.canceled === true ||
    value.status === true ||
    Number(value.code) === 1 ||
    Number(value.code) >= 200 && Number(value.code) < 300 ||
    Number(value.status) === 1 ||
    Number(value.status) >= 200 && Number(value.status) < 300
  ) return true;

  const text = [
    value.state,
    value.status,
    value.result,
    value.message,
    value.msg,
    value.detail,
    value.error,
  ].filter((item) => item !== undefined && item !== null).join(" ").toLowerCase();
  if (/(fail|error|gagal|ditolak|invalid|not found|pending|proses)/.test(text)) return false;
  if (/(cancel+ed?|dibatal|berhasil|sukses|success|^ok$)/.test(text)) return true;

  // Some cancel endpoints return an empty/object acknowledgment on HTTP 2xx.
  // Treat an object without an explicit failure state as confirmed.
  return Object.keys(value).length === 0 || !("state" in value && value.state);
}

function isWahubWaitingSession(sess) {
  return Boolean(
    sess &&
    sess.step === "tunggu_otp" &&
    String(sess.status || "").trim().toLowerCase() === "waiting"
  );
}

function isWahubPaidSession(sess) {
  const hasOtp = Boolean(sess?.lastOtp || sess?.firstOtp || sess?.otp);
  if (!hasOtp) return false;
  return true;
}

function canRetryWahubSession(sess) {
  return isWahubWaitingSession(sess) || isWahubPaidSession(sess);
}

const MAX_WAHUB_SESSIONS = 5;

function getWahubSessions(uid) {
  return wahubSessionDb.getAll(uid);
}

function getActiveWahubSessions(uid) {
  const all = getWahubSessions(uid);
  const active = [];
  const now = Date.now();
  for (const sess of all) {
    if (isWahubWaitingSession(sess)) {
      if (sess.expiresAt && now > sess.expiresAt) {
        if (isWahubPaidSession(sess)) {
          sess.status = "paid";
          sess.step = "selesai";
          sess.finishedAt = new Date().toISOString();
          wahubSessionDb.set(uid, sess);
        } else {
          try {
            refundWahubOrder(uid, sess);
            sess.status = "cancelled";
            sess.step = "selesai";
            sess.cancelledAt = new Date().toISOString();
            wahubSessionDb.set(uid, sess);
          } catch (e) {}
        }
      } else {
        active.push(sess);
      }
    }
  }
  return active;
}

function getWahubSession(uid, sessionKey = null) {
  return wahubSessionDb.find(uid, sessionKey);
}

function wahubSessionLimitReached(uid) {
  return getActiveWahubSessions(uid).length >= MAX_WAHUB_SESSIONS;
}

function wahubRetryCount(sess) {
  const count = Number(sess?.retryCount);
  return Number.isFinite(count) ? Math.min(Math.max(Math.trunc(count), 0), 3) : 0;
}

function refundWahubOrder(uid, sess) {
  if (!sess?.trxId) return { refunded: false, reason: "missing-transaction", amount: 0 };
  if (isWahubPaidSession(sess)) {
    return {
      refunded: false,
      reason: "already-paid",
      amount: Number(sess.hargaUser) || 0,
    };
  }
  return db.refundTransaction(sess.trxId, uid);
}

function normalizeWahubStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return "waiting";
  if (["cancel", "canceled", "cancelled", "expired", "failed"].includes(status)) return "cancelled";
  if (["complete", "completed", "paid"].includes(status)) return "paid";
  if (["waiting", "pending", "active", "processing", "success", "ok"].includes(status)) return "waiting";
  return status.replace(/[^a-z0-9_-]+/g, "_");
}

function saveWahubStatus(uid, sess, status, extra = {}) {
  Object.assign(sess, {
    status: normalizeWahubStatus(status),
    updatedAt: new Date().toISOString(),
    ...extra,
  });
  wahubSessionDb.set(uid, sess);
  return sess;
}

async function cancelWahubOrder(orderId, sess) {
  if (sess && isWahubPaidSession(sess)) {
    return {
      confirmed: false,
      rejected: true,
      reason: "already-paid",
    };
  }

  if (sess?.provider === "engineunicorn") {
    const res = await engineunicorn.cancel(orderId);
    if (res?.confirmed || res?.status === "cancelled" || res?.state === "cancelled") {
      return { confirmed: true, response: res?.response || res };
    }
    return { confirmed: Boolean(res?.confirmed), response: res };
  }

  const token = sess?.token || null;
  // Provider cancellation is retried so a transient network error does not
  // leave the user's balance locked forever. Refund follows confirmation.
  let lastResponse = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await wahub.cancel(orderId, token).catch(() => null);
    lastResponse = result;
    if (
      result?.ok === true ||
      result?.released === true ||
      ["cancelled", "canceled", "cancel", "released"].includes(String(result?.state || result?.status || "").toLowerCase())
    ) {
      return { confirmed: true, response: result };
    }
    if (isWahubCancelSuccess(result)) return { confirmed: true, response: result };
    if (attempt < 3) await sleep(1000);
  }
  console.error("WAHUB cancel belum dikonfirmasi:", {
    orderId,
    token,
    response: lastResponse,
    error: wahub.getLastError(),
  });
  return { confirmed: false, response: lastResponse };
}

function sensorPhone(p) {
  const s = String(p || "").replace(/[^0-9+]/g, "");
  if (s.length < 8) return s;
  return s.slice(0, 5) + "XXXXX" + s.slice(-2);
}

function svcEmoji(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("whatsapp"))  return "💚";
  if (n.includes("telegram"))  return "✈️";
  if (n.includes("instagram")) return "📸";
  if (n.includes("tiktok"))    return "🎵";
  if (n.includes("facebook"))  return "📘";
  if (n.includes("google"))    return "🔍";
  if (n.includes("twitter"))   return "🐦";
  if (n.includes("discord"))   return "🎮";
  return "📱";
}

// ── Notifikasi Siaran ke Channel ────────────────────────────
function getRealtimeNotifChannel() {
  return config.CHANNEL_NOTIF_REALTIME || config.CHANNEL_USERNAME || null;
}

async function sendChannelRealtimeOtpNotification({ serviceName, phone, otp, trxId }) {
  const targetChannel = getRealtimeNotifChannel();
  if (!targetChannel) return;
  try {
    await bot.telegram.sendMessage(
      targetChannel,
      `<blockquote>🔔 <b>NOTIF REALTIME OTP MASUK!</b>
━━━━━━━━━━━━━━━━
🔧 Layanan : <b>${escapeHTML(serviceName || "Nokos")}</b>
📱 Nomor   : <code>${escapeHTML(sensorPhone(phone))}</code>
🔑 Kode OTP: <code>${escapeHTML(otp)}</code>
🧾 TRX ID  : <code>${escapeHTML(trxId || "-")}</code>
⏰ Waktu   : <i>${getWaktu()}</i>
━━━━━━━━━━━━━━━━
⚡ <i>Transaksi otomatis & realtime via ${config.BOT_LINK || "bot"}</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[NOTIF CHANNEL OTP ERROR]", e.message);
  }
}

// ── Notifikasi Laporan Order ke Channel Khusus ──────────────
function getOrderReportChannel() {
  return config.CHANNEL_NOTIF_ORDER || null;
}

async function sendChannelOrderReportNotification({
  type = "WHATSAPP",
  username = "",
  userId = "",
  serviceName = "",
  phone = "",
  harga = 0,
  modal = 0,
  otp = "",
  serverName = "",
}) {
  const targetChannel = getOrderReportChannel();
  if (!targetChannel) return;

  const userDisplay = username ? username.replace(/^@/, "") : (userId ? String(userId) : "User");
  const modalText = (modal !== undefined && modal !== null && Number(modal) > 0)
    ? ` (Modal: Rp ${Number(modal).toLocaleString("id-ID")})`
    : "";

  const text = `<blockquote>💬 <b>LAPORAN ORDER OTP (${String(type).toUpperCase()})</b>

👤 User: <b>${escapeHTML(userDisplay)}</b>
🆔 ID: <code>${escapeHTML(String(userId || "-"))}</code>
💬 Layanan: <b>${escapeHTML(serviceName || "-")}</b>
📞 Nomor: <code>${escapeHTML(String(phone || "-"))}</code>
💰 Harga: <b>Rp ${Number(harga || 0).toLocaleString("id-ID")}</b>${modalText}
🔐 Kode: <code>${escapeHTML(String(otp || "-"))}</code>
🖥️ Server: <b>${escapeHTML(serverName || "-")}</b></blockquote>`;

  try {
    await bot.telegram.sendMessage(targetChannel, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[NOTIF CH ORDER ERROR]", err.message);
  }
}

async function sendChannelPesananSelesaiNotification() {
  // Dinonaktifkan sesuai permintaan: channel notif hanya untuk notifikasi OTP realtime saja
  return;
}

async function sendChannelReferralCommissionNotification({ inviterUsername, depositorUsername, depositAmount, commission, percent }) {
  if (!config.CHANNEL_USERNAME) return;
  try {
    const inviterDisplay = inviterUsername ? `@${escapeHTML(inviterUsername.slice(0, 3))}***` : "Member";
    await bot.telegram.sendMessage(
      config.CHANNEL_USERNAME,
      `<blockquote>🎁 <b>KOMISI REFERRAL CAIR!</b>
━━━━━━━━━━━━━━━━
👤 Pengundang : <b>${inviterDisplay}</b>
💵 Dari Deposit: <b>${rupiah(depositAmount)}</b>
🪙 Komisi (${percent}%): <b>+${rupiah(commission)}</b>
⏰ Waktu      : <i>${getWaktu()}</i>
━━━━━━━━━━━━━━━━
💡 <i>Ajak temanmu dengan link referral dan dapatkan komisi di setiap deposit mereka!</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[NOTIF CHANNEL REFERRAL ERROR]", e.message);
  }
}

async function sendChannelTopReferralNotification() {
  if (!config.CHANNEL_USERNAME) return false;
  const top = db.getTopReferrals(10);
  if (!top.length) return false;
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  const listText = top.map((u, i) => {
    const medal = medals[i] || `${i + 1}.`;
    const name = u.username ? `@${escapeHTML(u.username)}` : `User ${u.userId.slice(0, 4)}***`;
    return `${medal} <b>${name}</b>\n   👥 <b>${u.count}</b> Undangan | 🪙 Komisi: <b>${rupiah(u.earned)}</b>`;
  }).join("\n\n");

  try {
    await bot.telegram.sendMessage(
      config.CHANNEL_USERNAME,
      `<blockquote>🏆 <b>TOP REFERRAL LEADERBOARD</b>
━━━━━━━━━━━━━━━━
Berikut adalah member dengan referral terbanyak:

${listText}
━━━━━━━━━━━━━━━━
⚡ <i>Ajak temanmu sekarang dan raih komisi pasif tanpa batas!</i></blockquote>`,
      { parse_mode: "HTML" }
    );
    return true;
  } catch (e) {
    console.error("[NOTIF CHANNEL TOP REF ERROR]", e.message);
    return false;
  }
}

const LIST_PAGE_SIZE = 20;
const WA_SERVICE_PAGE_SIZE = 21;

function shortButtonText(value, maxLength = 24) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatStock(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function parseProfitInput(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (raw.includes("%") || raw.includes("persen") || raw.includes("percent")) {
    const val = parseFloat(raw.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(val) && val >= 0) return { mode: "percent", value: val };
    return null;
  }
  const val = parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (Number.isFinite(val) && val >= 0) return { mode: "flat", value: Math.round(val) };
  return null;
}

function twoColumnButtons(items, createButton) {
  const buttons = [];
  for (let i = 0; i < items.length; i += 2) {
    const row = [createButton(items[i], i)];
    if (items[i + 1]) row.push(createButton(items[i + 1], i + 1));
    buttons.push(row);
  }
  return buttons;
}

function threeColumnButtons(items, createButton) {
  const buttons = [];
  for (let i = 0; i < items.length; i += 3) {
    const row = [createButton(items[i], i)];
    if (items[i + 1]) row.push(createButton(items[i + 1], i + 1));
    if (items[i + 2]) row.push(createButton(items[i + 2], i + 2));
    buttons.push(row);
  }
  return buttons;
}

function addPageButtons(buttons, page, totalPage, prevData, nextData, backData) {
  const navigation = [];
  if (page > 1) navigation.push(Markup.button.callback("⬅️ Prev", prevData));
  if (page < totalPage) navigation.push(Markup.button.callback("Next ➡️", nextData));
  if (navigation.length) buttons.push(navigation);
  if (backData) buttons.push([Markup.button.callback("↩️ Kembali", backData)]);
}

async function updateOrderMessage(ctx, loadMsg, text, options) {
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      text,
      options
    );
    return loadMsg.message_id;
  } catch (error) {
    // The provider order is already created at this point. A Telegram
    // notification error must never turn a real pending order into a failed
    // order or trigger a coin refund.
    console.error("Order success notification error:", error.message);
    const fallback = await ctx.replyWithHTML(text, options).catch((replyError) => {
      console.error("Order fallback notification error:", replyError.message);
      return null;
    });
    return fallback?.message_id || loadMsg.message_id;
  }
}

function normalizeOtpcepatOrder(value) {
  const candidates = [
    value,
    value?.data,
    value?.data?.data,
    value?.result,
    value?.order,
  ];
  for (const candidate of candidates) {
    const normalized = otpcepat.normalizeOrder(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function getReferralPayload(ctx) {
  const payload = ctx.startPayload || ctx.message?.text?.trim().split(/\s+/)[1] || "";
  return payload.toLowerCase().startsWith("ref_") ? payload.slice(4) : null;
}

function joinTargetFromInput(input, explicitLink = "") {
  const value = String(input || "").trim();
  const link = String(explicitLink || "").trim();
  if (!value) return null;

  if (/^-100\d+$/.test(value)) {
    return {
      id: value,
      link: link || `https://t.me/c/${value.slice(4)}`,
      username: "",
      lookup: value,
    };
  }

  const telegramLink = value.match(/^https?:\/\/t\.me\/(.+)$/i);
  const slug = telegramLink ? telegramLink[1].split(/[/?#]/)[0] : value;
  if (!slug) return null;

  if (slug.startsWith("+") || slug.startsWith("joinchat/")) {
    return {
      id: "",
      link: value,
      username: "",
      lookup: null,
    };
  }

  const username = `@${slug.replace(/^@/, "")}`;
  return {
    id: "",
    link: link || `https://t.me/${username.slice(1)}`,
    username,
    lookup: username,
  };
}

function getEffectiveMandatoryJoinSettings() {
  const settings = db.getMandatoryJoinSettings();
  const chats = Array.isArray(settings.chats) ? [...settings.chats] : [];

  const ensureChannel = (targetRaw, defaultTitle, defaultId) => {
    if (!targetRaw) return;
    const raw = String(targetRaw).trim();
    const uname = raw.startsWith("@") ? raw : (raw.startsWith("-100") ? "" : `@${raw}`);
    const link = uname ? `https://t.me/${uname.replace(/^@/, "")}` : (raw.startsWith("http") ? raw : "");
    const exists = chats.some(item =>
      (uname && String(item.username).toLowerCase() === uname.toLowerCase()) ||
      (raw.startsWith("-100") && String(item.id) === raw) ||
      (link && String(item.link).toLowerCase() === link.toLowerCase())
    );
    if (!exists) {
      const newChat = {
        id: raw.startsWith("-100") ? raw : (defaultId || ""),
        title: defaultTitle,
        link: link || (uname ? `https://t.me/${uname.replace(/^@/, "")}` : ""),
        username: uname || (raw.startsWith("@") ? raw : ""),
      };
      chats.push(newChat);
      try { db.addMandatoryJoin(newChat); } catch {}
    }
  };

  ensureChannel(config.CHANNEL_USERNAME, "CALABAY Official Channel", "-1002215192632");
  ensureChannel(config.CHANNEL_NOTIF_REALTIME, "CALABAY Notif Realtime", "-1004499764167");

  return {
    enabled: settings.enabled === true,
    chats,
  };
}

async function checkMandatoryJoin(ctx, uid) {
  const settings = getEffectiveMandatoryJoinSettings();
  if (!settings.enabled || !settings.chats.length || isOwner(ctx)) {
    return { ok: true, missing: [] };
  }

  const missing = [];
  for (const chat of settings.chats) {
    try {
      const targetChat = chat.username || chat.id;
      const member = await ctx.telegram.getChatMember(targetChat, uid);
      const isMember = ["creator", "administrator", "member"].includes(member.status) ||
        (member.status === "restricted" && member.is_member !== false);
      if (!isMember) missing.push(chat);
    } catch {
      // Jika bot belum menjadi admin/member, jangan izinkan bypass verifikasi.
      missing.push({ ...chat, unavailable: true });
    }
  }
  return { ok: missing.length === 0, missing };
}

async function showMandatoryJoinPrompt(ctx, uid, missing = null) {
  const result = missing ? { missing } : await checkMandatoryJoin(ctx, uid);
  const settings = getEffectiveMandatoryJoinSettings();
  
  const channelStatuses = settings.chats.map(chat => {
    const isMissing = result.missing.some(m =>
      (m.id && chat.id && String(m.id) === String(chat.id)) ||
      (m.username && chat.username && String(m.username).toLowerCase() === String(chat.username).toLowerCase()) ||
      (m.link && chat.link && String(m.link).toLowerCase() === String(chat.link).toLowerCase())
    );
    const unavailable = result.missing.some(m =>
      m.unavailable && (
        (m.id && chat.id && String(m.id) === String(chat.id)) ||
        (m.username && chat.username && String(m.username).toLowerCase() === String(chat.username).toLowerCase())
      )
    );
    return {
      ...chat,
      joined: !isMissing,
      unavailable,
    };
  });

  const buttons = [];
  for (const chat of channelStatuses) {
    if (chat.link) {
      const badge = chat.joined ? "✅" : "📢";
      const statusLabel = chat.joined ? " (Sudah)" : "";
      buttons.push([
        Markup.button.url(`${badge} Join ${shortButtonText(chat.title || "Channel", 24)}${statusLabel}`, chat.link)
      ]);
    }
  }
  buttons.push([Markup.button.callback("✅ Saya Sudah Join", `check_join_${uid}`)]);

  const listText = channelStatuses.map((chat, index) => {
    const statusText = chat.joined ? "🟢 <b>Sudah Join</b>" : "🔴 <b>Belum Join</b>";
    return `${index + 1}. <b>${escapeHTML(chat.title || chat.username || "Channel/Grup")}</b>\n   Status: ${statusText}` +
      (chat.unavailable ? "\n   ⚠️ Verifikasi belum tersedia, pastikan bot sudah admin di channel ini." : "");
  }).join("\n\n");

  await ctx.replyWithHTML(
    `<blockquote>🔐 <b>WAJIB JOIN CHANNEL</b>

Sebelum menggunakan bot, silakan bergabung ke channel kami terlebih dahulu:

${listText}
━━━━━━━━━━━━━━━━
💡 <i>Setelah join semua channel di atas, tekan tombol <b>Saya Sudah Join</b>.</i></blockquote>`,
    Markup.inlineKeyboard(buttons)
  );
}

async function completeReferralIfEligible(ctx, uid) {
  const result = db.processReferralReward(uid);
  if (!result.rewarded) return;
  await bot.telegram.sendMessage(
    result.inviterId,
    `<blockquote>🎉 <b>Referral berhasil!</b>
User baru menggunakan kode referral kamu.
🪙 Bonus: <b>${rupiah(result.reward)}</b>
💰 Saldo kamu sekarang: <b>${rupiah(db.getCoin(result.inviterId))}</b></blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

// In-memory sessions
const sessions = {};

// Full SMS disimpan sementara di memory agar callback Telegram tetap pendek.
// Callback data Telegram dibatasi 64 byte dan tidak cocok untuk menyimpan base64 SMS.
const fullSmsMessages = new Map();

// Bahasa per user (in-memory, reset saat restart)
const userLang = {}; // { [userId]: 'id' | 'en' }

// Active QRIS transactions { [uid]: { depoId, interval, msgId } }
const activeTransactions = {};

function getLang(uid) { return userLang[uid] || "id"; }
function isEN(uid) { return getLang(uid) === "en"; }

// Maintenance mode always leaves the owner in control.
bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    const uid = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || String(uid);
    if (!db.getUser(uid)) {
      db.registerUser(uid, username);
    }
  }
  if (!db.getMaintenance() || isOwner(ctx)) return next();
  if (ctx.callbackQuery) {
    return ctx.answerCbQuery("⚠️ Bot sedang maintenance. Coba lagi nanti.", { show_alert: true }).catch(() => {});
  }
  if (ctx.message) {
    return ctx.replyWithHTML(
      "<blockquote>⚠️ <b>BOT SEDANG MAINTENANCE</b>\nSilakan coba lagi beberapa saat.</blockquote>"
    ).catch(() => {});
  }
  return next();
});

// ── /start ────────────────────────────────────────────────
bot.start(async (ctx) => {
  const uid  = ctx.from.id;
  const name = ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name;
  db.registerUser(
    uid,
    ctx.from.username || ctx.from.first_name,
    getReferralPayload(ctx)
  );
  await db.syncUser(uid);

  const joinStatus = await checkMandatoryJoin(ctx, uid);
  if (!joinStatus.ok) {
    return showMandatoryJoinPrompt(ctx, uid, joinStatus.missing);
  }
  await completeReferralIfEligible(ctx, uid);

  // WAHUB order lives in sessions.json, while the other provider flows
  // continue using the short-lived in-memory interaction session.
  const activeWahub = getActiveWahubSessions(uid);
  if (activeWahub.length > 0) {
    return showActiveOrdersPrompt(ctx, uid, activeWahub);
  }
  const existSess = sessions[uid];
  if (existSess?.step === "tunggu_otp") {
    return ctx.replyWithHTML(
`<blockquote>⚠️ <b>Kamu masih punya order aktif!</b>
📱 Nomor: <code>${escapeHTML(existSess.phone || "-")}</code>
⏳ Tunggu OTP atau batalkan order dulu.</blockquote>`
    );
  }

  // Clear session lain yang tidak aktif
  if (existSess && existSess.step !== "tunggu_otp") {
    delete sessions[uid];
  }

  // Cek active QRIS transaction
  const hasActiveQris = activeTransactions[uid] ? true : false;

  const captionText = (en) => [
  `${en ? "👋 Hello" : "👋 Halo"}, <b>${name}</b>!`,
  "",
  "🌟 <b>NOKOS VIRTUAL BOT</b> 🌟",
  en
    ? "Buy virtual OTP numbers 24/7 — fast, cheap, and automatic!"
    : "Beli nomor OTP virtual otomatis 24/7 — cepat, murah, dan otomatis!",
  ...(hasActiveQris
    ? [
        "",
        en
          ? "⚡ <b>You have an active payment session!</b>\nGo to 🪙 Coin &amp; Deposit to continue."
          : "⚡ <b>Kamu punya sesi pembayaran aktif!</b>\nPergi ke 🪙 Coin &amp; Deposit untuk melanjutkan."
      ]
    : []),
  "",
  `🌐 ${en ? "<b>Choose Language / Pilih Bahasa</b>" : "<b>Pilih Bahasa / Choose Language</b>"}`
].join("\n");

  try {
    const msg = await ctx.replyWithPhoto(config.START_IMAGE, {
      caption: captionText(false),
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🇮🇩 Indonesia", `lang_id_${uid}`),
         Markup.button.callback("🇬🇧 English",   `lang_en_${uid}`)],
      ]).reply_markup,
    });
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 5 * 60 * 1000);
  } catch {
    // fallback text jika foto gagal
    const msg = await ctx.replyWithHTML(captionText(false),
      Markup.inlineKeyboard([
        [Markup.button.callback("🇮🇩 Indonesia", `lang_id_${uid}`),
         Markup.button.callback("🇬🇧 English",   `lang_en_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 5 * 60 * 1000);
  }
});

bot.action(/^check_join_(\d+)$/, async (ctx) => {
  const uid = Number(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  await ctx.answerCbQuery("Memeriksa status join...");
  const joinStatus = await checkMandatoryJoin(ctx, uid);
  if (!joinStatus.ok) {
    await ctx.answerCbQuery("Kamu belum join semua channel/grup.", { show_alert: true });
    return showMandatoryJoinPrompt(ctx, uid, joinStatus.missing);
  }
  await completeReferralIfEligible(ctx, uid);
  await ctx.deleteMessage().catch(() => {});
  await showMainMenu(ctx, uid);
});

// Callback pilih bahasa
bot.action(/^lang_(id|en)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const lang = ctx.match[1];
  const uid  = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  userLang[uid] = lang;
  await ctx.deleteMessage().catch(() => {});
  await showMainMenu(ctx, uid);
});

async function showMainMenu(ctx, uid) {
  await db.syncUser(uid);
  const coin = db.getCoin(uid);
  const name = ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name;
  const en   = isEN(uid);

  // Cek sesi order aktif
  const activeSess = sessions[uid];
  const hasOrderAktif = activeSess && activeSess.step === "tunggu_otp";
  const hasQrisAktif  = activeTransactions[uid] ? true : false;

  const infoAktif = hasOrderAktif
    ? (en
        ? `\n\n⚡ <b>Active order!</b> Waiting for OTP on <code>${activeSess.phone || "-"}</code>`
        : `\n\n⚡ <b>Ada order aktif!</b> Menunggu OTP nomor <code>${activeSess.phone || "-"}</code>`)
    : hasQrisAktif
      ? (en
          ? `\n\n💳 <b>Active payment session!</b> Go to 🪙 Coin &amp; Deposit to complete.`
          : `\n\n💳 <b>Ada sesi pembayaran aktif!</b> Pergi ke 🪙 Coin &amp; Deposit untuk selesaikan.`)
      : "";

  const user = db.getUser(uid);
  const isReseller = db.isReseller(uid);
  const resellerSettings = db.getResellerSettings();
  const monthlyTrx = Number(user?.monthlyTrx || 0);
  const threshold = Number(resellerSettings.threshold || 100);

  const roleBadge = isReseller
    ? (en ? "⭐ Role: <b>RESELLER (Special Price)</b>" : "⭐ Role: <b>RESELLER (Harga Khusus)</b>")
    : (en
        ? `👤 Role: <b>Member (${monthlyTrx}/${threshold} TRX this month)</b>`
        : `👤 Role: <b>Member (${monthlyTrx}/${threshold} TRX bulan ini)</b>`);

  const teks = en
? `<blockquote>🌟 <b>NOKOS VIRTUAL BOT</b> 🌟

👋 Hello, <b>${name}</b>!
${roleBadge}
🕐 <i>${getWaktu()}</i>

📊 <b>STATISTICS</b>
├ 👥 Total Users    : <b>${db.getTotalUsers()}</b>
└ 🔄 Total TRX      : <b>${db.getTotalTrx()}</b>


🪙 <b>Your Coin: ${rupiah(coin)}</b>

Buy virtual OTP numbers 24/7!${infoAktif}</blockquote>`
: `<blockquote>🌟 <b>NOKOS VIRTUAL BOT</b> 🌟

👋 Halo, <b>${name}</b>!
${roleBadge}
🕐 <i>${getWaktu()}</i>

📊 <b>STATISTIK</b>
├ 👥 Total Pengguna  : <b>${db.getTotalUsers()}</b>
└ 🔄 Total Transaksi : <b>${db.getTotalTrx()}</b>

🪙 <b>Coin kamu: ${rupiah(coin)}</b>

Beli nomor OTP virtual otomatis 24/7!${infoAktif}</blockquote>`;

  const keyboard = en
    ? Markup.keyboard([
        ["🛒 Buy Nokos",         "⭐ Reseller"],
        ["🪙 Coin & Deposit",    "📜 Transaction History"],
        ["❓ How to Order",      "👑 Top Buyer"],
        ["🔑 API Key",           "🎁 Referral"],
        ["💬 Admin"],
      ]).resize()
    : Markup.keyboard([
        ["🛒 Beli Nokos",        "⭐ Reseller"],
        ["🪙 Coin & Deposit",    "📜 Riwayat Transaksi"],
        ["❓ Cara Order",        "👑 Top Buyer"],
        ["🔑 API Key",           "🎁 Referral"],
        ["💬 Admin"],
      ]).resize();

  try {
    await ctx.replyWithPhoto(config.START_IMAGE, {
      caption: teks,
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup,
    });
  } catch {
    await ctx.replyWithHTML(teks, keyboard);
  }
}

async function showPublicProductList(ctx, uid, mode = "list", page = 1, editMsgId = null) {
  const services = await wahub.getServices();
  const totalPage = Math.max(1, Math.ceil(services.length / LIST_PAGE_SIZE));
  const en = isEN(uid);
  const title = mode === "popular"
    ? (en ? "POPULAR PRODUCTS" : "PRODUK POPULER")
    : (en ? "PRODUCT LIST" : "LIST PRODUK");

  let teks = `<blockquote>${mode === "popular" ? "✨" : "📋"} <b>${title}</b>\n`;
  teks += `━━━━━━━━━━━━━━━━\n`;
  if (!services.length) {
    teks += en ? "Services are temporarily unavailable." : "Layanan sedang tidak tersedia.";
  } else {
    const start = (page - 1) * LIST_PAGE_SIZE;
    for (const service of services.slice(start, start + LIST_PAGE_SIZE)) {
      const price = db.calculatePrice("wahub", service.price, service.id, uid);
      const stock = Number(service.stock || 0).toLocaleString("id-ID");
      teks += `${svcEmoji(service.name)} <b>${escapeHTML(service.name)}</b>\n` +
        `   ${en ? "Price" : "Harga"}: <b>${rupiah(price)}</b> · ` +
        `${en ? "Stock" : "Stok"}: <b>${stock} pcs</b>\n\n`;
    }
  }
  teks += `━━━━━━━━━━━━━━━━\n${en ? "Page" : "Hal"} ${page}/${totalPage}</blockquote>`;

  const buttons = [];
  addPageButtons(
    buttons,
    page,
    totalPage,
    `catalog_pg_${mode}_${uid}_${page - 1}`,
    `catalog_pg_${mode}_${uid}_${page + 1}`,
    `catalog_back_${uid}`
  );
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options);
  }
  return ctx.replyWithHTML(teks, { reply_markup: options.reply_markup });
}

bot.action(/^catalog_pg_(list|popular)_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const mode = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  const page = parseInt(ctx.match[3]);
  if (uid !== ctx.from.id) return;
  await showPublicProductList(
    ctx,
    uid,
    mode,
    page,
    ctx.callbackQuery?.message?.message_id
  );
});

bot.action(/^catalog_back_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  await showMainMenu(ctx, uid);
});

// English keyboard handlers
bot.hears("🛒 Buy Nokos",          showServerChoice);
bot.hears("📋 Product List",       async (ctx) => {
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Loading...</i></blockquote>");
  await showPublicProductList(ctx, ctx.from.id, "list", 1, loadMsg.message_id);
});
bot.hears("📜 Transaction History", async (ctx) => {
  const riwayat = db.getRiwayat(ctx.from.id, 5);
  const coin    = db.getCoin(ctx.from.id);
  if (!riwayat.length) return ctx.replyWithHTML(`<blockquote>📜 No transactions yet.\n🪙 Your coin: <b>${rupiah(coin)}</b></blockquote>`);
  let teks = `<blockquote>📜 <b>TRANSACTION HISTORY</b>\n🪙 Coin: <b>${rupiah(coin)}</b>\n━━━━━━━━━━━━━━━━\n`;
  for (const t of riwayat) {
    teks += `🧾 <code>${t.id}</code>\n   📱 ${sensorPhone(t.phone)} | 💰 ${rupiah(t.harga)}\n   📅 ${new Date(t.date).toLocaleString("en-US", { timeZone: "Asia/Jakarta" })}\n\n`;
  }
  teks += "━━━━━━━━━━━━━━━━</blockquote>";
  await ctx.replyWithHTML(teks);
});
bot.hears("❓ How to Order", async (ctx) => {
  await ctx.replyWithHTML(
`<blockquote>❓ <b>HOW TO ORDER</b>
━━━━━━━━━━━━━━━━
1️⃣ Deposit coin via <b>🪙 Coin &amp; Deposit</b>
2️⃣ Press <b>🛒 Buy Nokos</b>
3️⃣ Choose country → service → price
4️⃣ Coin deducted automatically
5️⃣ Number sent instantly
6️⃣ OTP arrives → sent here ✅
━━━━━━━━━━━━━━━━
💬 ${config.urladmin}</blockquote>`
  );
});
bot.hears("✨ Popular Products", async (ctx) => {
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Loading...</i></blockquote>");
  await showPublicProductList(ctx, ctx.from.id, "popular", 1, loadMsg.message_id);
});

// ── 🪙 Coin & Deposit ─────────────────────────────────────
bot.hears("🪙 Coin & Deposit", cmdCoin);
bot.command("deposit", cmdCoin);

async function cmdCoin(ctx) {
  const uid  = ctx.from.id;
  const coin = db.getCoin(uid);
  const en   = isEN(uid);

  // Cek apakah ada QRIS aktif
  if (activeTransactions[uid]) {
    return ctx.replyWithHTML(
`<blockquote>⚡ <b>${en ? "You have an active payment!" : "Kamu punya pembayaran aktif!"}</b>
${en ? "Complete or wait for the current QRIS transaction to expire." : "Selesaikan atau tunggu transaksi QRIS saat ini kedaluwarsa."}</blockquote>`
    );
  }

  const isManualOn = db.getManualDeposit();
  const keyboardButtons = [
    [Markup.button.callback(
      en ? "⚡ Auto QRIS" : "⚡ QRIS Otomatis",
      `metode_auto_${uid}`
    )],
  ];
  if (isManualOn) {
    keyboardButtons.push([Markup.button.callback(
      en ? "📤 Manual" : "📤 Manual",
      `metode_manual_${uid}`
    )]);
  }

  const msg = await ctx.replyWithHTML(
en
? `<blockquote>🪙 <b>COIN &amp; DEPOSIT</b>
━━━━━━━━━━━━━━━━
💰 Your coin : <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Choose deposit method:</blockquote>`
: `<blockquote>🪙 <b>COIN &amp; DEPOSIT</b>
━━━━━━━━━━━━━━━━
💰 Coin kamu : <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Pilih metode deposit:</blockquote>`,
    Markup.inlineKeyboard(keyboardButtons)
  );

  setTimeout(() => {
    bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  }, 2 * 60 * 1000);
}

// ── Callback: Pilih Metode Deposit ───────────────────────
bot.action(/^metode_(auto|manual)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const metode = ctx.match[1];
  const uid    = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});

  if (metode === "auto") {
    sessions[uid] = { step: "deposit_auto_nominal" };
    const en = isEN(uid);
    const msg = await ctx.replyWithHTML(
en
? `<blockquote>⚡ <b>AUTO QRIS DEPOSIT (Instant)</b>
━━━━━━━━━━━━━━━━
Enter the deposit amount (min. Rp1.000):
Example: <code>15000</code>

Payment will be verified automatically!</blockquote>`
: `<blockquote>⚡ <b>DEPOSIT QRIS OTOMATIS (Instan)</b>
━━━━━━━━━━━━━━━━
Ketik nominal deposit (min. Rp1.000):
Contoh: <code>15000</code>

Pembayaran akan terverifikasi otomatis!</blockquote>`
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 10 * 60 * 1000);
    // Auto cancel input jika 10 menit tidak ada aksi
    setTimeout(() => {
      if (sessions[uid]?.step === "deposit_auto_nominal") {
        delete sessions[uid];
        ctx.reply("⏰ Sesi deposit habis. Ulangi /deposit.").catch(() => {});
      }
    }, 10 * 60 * 1000);
  } else {
    // Manual — pilih nominal preset jika fitur aktif
    const en = isEN(uid);
    if (!db.getManualDeposit()) {
      return ctx.replyWithHTML(
        en
          ? `<blockquote>❌ <b>Manual deposit is currently disabled by admin.</b>\nPlease use Auto QRIS.</blockquote>`
          : `<blockquote>❌ <b>Pembayaran deposit manual sedang dinonaktifkan oleh admin.</b>\nSilakan gunakan metode QRIS Otomatis.</blockquote>`
      );
    }
    const msg = await ctx.replyWithHTML(
en
? `<blockquote>📤 <b>MANUAL DEPOSIT</b>
━━━━━━━━━━━━━━━━
💰 Your coin : <b>${rupiah(db.getCoin(uid))}</b>
━━━━━━━━━━━━━━━━
Choose deposit amount:</blockquote>`
: `<blockquote>📤 <b>DEPOSIT MANUAL</b>
━━━━━━━━━━━━━━━━
💰 Coin kamu : <b>${rupiah(db.getCoin(uid))}</b>
━━━━━━━━━━━━━━━━
Pilih nominal deposit:</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000",   `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000",  `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000",  `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000",  `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 2 * 60 * 1000);
  }
});

// ── Callback: Pilih nominal deposit MANUAL ───────────────
bot.action(/^dep_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const nominal = parseInt(ctx.match[1]);
  const uid     = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  if (!db.getManualDeposit()) {
    const en = isEN(uid);
    return ctx.replyWithHTML(
      en
        ? `<blockquote>❌ <b>Manual deposit is currently disabled by admin.</b></blockquote>`
        : `<blockquote>❌ <b>Pembayaran deposit manual sedang dinonaktifkan oleh admin.</b></blockquote>`
    );
  }

  await ctx.deleteMessage().catch(() => {});

  sessions[uid] = { step: "deposit_bukti", nominal };

  const instruksi =
`<blockquote>💳 <b>DEPOSIT COIN</b>
━━━━━━━━━━━━━━━━
🪙 Nominal : <b>${rupiah(nominal)}</b>
━━━━━━━━━━━━━━━━
Transfer ke:
📲 DANA : <code>${config.DANA_NUMBER}</code>
👤 A/N  : <b>${config.DANA_NAME}</b>
━━━━━━━━━━━━━━━━
Atau scan QRIS di bawah 👇

Setelah transfer, <b>kirim screenshot bukti</b> ke bot ini!</blockquote>`;

  try {
    const msg = await ctx.replyWithPhoto(config.QRIS_URL, { caption: instruksi, parse_mode: "HTML" });
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 15 * 60 * 1000);
  } catch {
    const msg = await ctx.replyWithHTML(instruksi);
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 15 * 60 * 1000);
  }

  // Auto expire 15 menit
  setTimeout(() => {
    if (sessions[uid]?.step === "deposit_bukti") {
      delete sessions[uid];
      ctx.reply("⏰ Sesi deposit habis. Ulangi /deposit.").catch(() => {});
    }
  }, 15 * 60 * 1000);
});

// ── Tangkap teks: nominal QRIS otomatis ──────────────────
bot.on("text", async (ctx, next) => {
  const uid  = ctx.from.id;
  const sess = sessions[uid];
  const text = ctx.message.text;

  if (sess?.step === "owner_default_profit_value") {
    const parsed = parseProfitInput(text);
    if (!parsed) {
      return ctx.reply("❌ Format profit tidak valid. Contoh: 500 (flat) atau 10% (persen).");
    }
    const target = sess.profitTargetProvider;
    const ok = db.setProfit(target, parsed.mode, parsed.value);
    delete sessions[uid];
    if (ok) {
      const display = parsed.mode === "percent" ? `${parsed.value}%` : rupiah(parsed.value);
      const targetLabel = target === "all" ? "Semua Server" : (target === "fastbit" || target === "herosms" ? "Server 1⃣ (SMS)" : target === "rumahotp" ? "Server 2⃣ (FlashCall + SMS)" : target === "wahub" ? "Server 1⃣ (WA)" : "Server 2⃣ (WA)");
      return ctx.replyWithHTML(`<blockquote>✅ Profit default <b>${targetLabel}</b> berhasil disimpan: <b>${display}</b> (${parsed.mode}).</blockquote>`);
    }
    return ctx.replyWithHTML("<blockquote>❌ Gagal menyimpan profit server.</blockquote>");
  }

  if (sess?.step === "owner_profit_value") {
    const parsed = parseProfitInput(text);
    if (!parsed) {
      return ctx.reply("❌ Format profit tidak valid. Contoh: 500 (flat) atau 10% (persen).");
    }
    const saved = db.setServiceProfit(
      sess.profitProvider,
      sess.profitServiceId,
      sess.profitServiceName,
      parsed.value,
      parsed.mode
    );
    delete sessions[uid];
    const display = parsed.mode === "percent" ? `${parsed.value}%` : rupiah(parsed.value);
    return ctx.replyWithHTML(
      saved
        ? `<blockquote>✅ Profit layanan disimpan.\n🔧 Layanan: <b>${escapeHTML(sess.profitServiceName)}</b>\n💰 Profit: <b>${display}</b></blockquote>`
        : "<blockquote>❌ Gagal menyimpan profit layanan.</blockquote>"
    );
  }

  if (sess?.step === "waiting_sms_service_search") {
    const query = String(text || "").trim();
    if (!query) {
      return ctx.reply("❌ Masukkan nama layanan yang ingin dicari.");
    }
    const server = sess.searchServer || "fastbit";
    const masterList = sess.fastbitServices || sess.heroServices || sess.roServices || [];
    const q = query.toLowerCase();
    const matched = masterList.filter((s) =>
      String(s.name || "").toLowerCase().includes(q) ||
      String(s.id || "").toLowerCase() === q
    );

    if (!matched.length) {
      return ctx.replyWithHTML(
        `<blockquote>❌ <b>Layanan Tidak Ditemukan</b>
━━━━━━━━━━━━━━━━
Tidak ada layanan yang cocok dengan kata kunci: <b>${escapeHTML(query)}</b>.</blockquote>`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Coba Cari Lagi", `search_sms_svc_${server}_${uid}`)],
          [Markup.button.callback("📋 Tampilkan Semua Layanan", `reset_sms_svc_${server}_${uid}`)],
        ])
      );
    }

    sess.filteredServices = matched;
    sess.searchQuery = query;
    sess.servicePage = 1;
    if (server === "fastbit") {
      sess.step = "fb_pilih_service";
      await showFastbitServices(ctx, uid);
    } else {
      sess.step = "hs_pilih_service";
      await showHeroServices(ctx, uid);
    }
    return;
  }

  if (sess?.step === "deposit_auto_nominal") {
    const nominal = parseInt(text.replace(/[^0-9]/g, ""));
    const en      = isEN(uid);

    if (isNaN(nominal) || nominal < 1000) {
      return ctx.replyWithHTML(
        en
          ? `<blockquote>❌ Minimum deposit is <b>Rp1.000</b>. Enter a valid amount.</blockquote>`
          : `<blockquote>❌ Minimal deposit <b>Rp1.000</b>. Masukkan nominal yang valid.</blockquote>`
      );
    }

    delete sessions[uid];
    await prosesQrisOtomatis(ctx, uid, nominal, en);
    return;
  }

  return next();
});

async function handleDepositSuccess(depoId, sourceMetode = "QRIS Otomatis (PanzzPay)") {
  const dep = db.getDeposit(depoId);
  if (!dep || dep.status !== "waiting_payment") return false;

  db.updateDeposit(depoId, "success");
  const newCoin = db.addCoin(dep.userId, dep.nominal);

  const active = activeTransactions[dep.userId];
  if (active && active.depoId === depoId) {
    if (active.interval) clearInterval(active.interval);
    if (active.expireTimeout) clearTimeout(active.expireTimeout);
    delete activeTransactions[dep.userId];
  }

  const en = db.getUserLang ? db.getUserLang(dep.userId) === "en" : false;

  // Hapus pesan QRIS agar gambar QR hilang dan tidak bisa di-scan ulang oleh buyer
  const targetChatId = active?.chatId || dep.chatId || dep.userId;
  const targetMsgId = active?.msgId || dep.msgId;

  if (targetChatId && targetMsgId) {
    let deleted = false;
    try {
      await bot.telegram.deleteMessage(targetChatId, targetMsgId);
      deleted = true;
    } catch {
      deleted = false;
    }

    // Fallback jika Telegram gagal menghapus (misal pesan terlampau lama):
    // Ubah caption agar QR ditandai LUNAS & JANGAN SCAN ULANG, serta hapus tombolnya
    if (!deleted) {
      const fallbackCaption = en
        ? `<blockquote>✅ <b>PAYMENT SUCCESSFUL (PAID)</b>\n━━━━━━━━━━━━━━━━\n⚠️ <i>DO NOT SCAN AGAIN! QRIS has already been paid and expired.</i>\n💰 Deposit: <b>${rupiah(dep.nominal)}</b></blockquote>`
        : `<blockquote>✅ <b>PEMBAYARAN BERHASIL (LUNAS)</b>\n━━━━━━━━━━━━━━━━\n⚠️ <i>JANGAN SCAN ULANG! QRIS sudah lunas dan tidak berlaku lagi.</i>\n💰 Deposit: <b>${rupiah(dep.nominal)}</b></blockquote>`;

      await bot.telegram.editMessageCaption(targetChatId, targetMsgId, null, fallbackCaption, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }).catch(async () => {
        await bot.telegram.editMessageText(targetChatId, targetMsgId, null, fallbackCaption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      });
    }
  }

  await bot.telegram.sendMessage(
    dep.userId,
    en
      ? `<blockquote>✅ <b>PAYMENT SUCCESS!</b>\n━━━━━━━━━━━━━━━━\n💰 Added       : <b>${rupiah(dep.nominal)}</b>\n🪙 Your Coin   : <b>${rupiah(newCoin)}</b>\n🆔 ID          : <code>${depoId}</code>\n━━━━━━━━━━━━━━━━\nStart buying Nokos! 🚀</blockquote>`
      : `<blockquote>✅ <b>PEMBAYARAN BERHASIL!</b>\n━━━━━━━━━━━━━━━━\n💰 Ditambahkan : <b>${rupiah(dep.nominal)}</b>\n🪙 Coin kamu   : <b>${rupiah(newCoin)}</b>\n🆔 ID          : <code>${depoId}</code>\n━━━━━━━━━━━━━━━━\nSilakan mulai beli Nokos! 🚀</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});

  await sendDepositNotification({
    userId:       dep.userId,
    userName:     dep.username || "-",
    userUsername: dep.username || "-",
    nominal:      dep.nominal,
    saldoSebelum: newCoin - dep.nominal,
    saldoSekarang: newCoin,
    depoId,
    metode:       sourceMetode,
  });

  // Proses Komisi Referral Deposit
  try {
    const refResult = db.processDepositReferralCommission(dep.userId, dep.nominal);
    if (refResult.rewarded) {
      await bot.telegram.sendMessage(
        refResult.inviterId,
        `<blockquote>🎉 <b>KOMISI REFERRAL MASUK!</b>
━━━━━━━━━━━━━━━━
Teman yang kamu undang (<b>@${escapeHTML(refResult.depositorUsername)}</b>) baru saja melakukan deposit sebesar <b>${rupiah(refResult.depositAmount)}</b>.

🪙 Komisi kamu (${refResult.percent}%): <b>+${rupiah(refResult.commission)}</b>
💰 Saldo kamu sekarang: <b>${rupiah(db.getCoin(refResult.inviterId))}</b>
━━━━━━━━━━━━━━━━
Terus bagikan link referral kamu dan raih komisi pasif tanpa batas! 🚀</blockquote>`,
        { parse_mode: "HTML" }
      ).catch(() => {});

      sendChannelReferralCommissionNotification({
        inviterUsername: refResult.inviterUsername,
        depositorUsername: refResult.depositorUsername,
        depositAmount: refResult.depositAmount,
        commission: refResult.commission,
        percent: refResult.percent,
      });
    }
  } catch (err) {
    console.error("[REFERRAL DEPOSIT ERROR]", err.message);
  }

  return true;
}

async function prosesQrisOtomatis(ctx, uid, nominal, en) {
  const depoId  = "DEP-" + Date.now().toString().slice(-8);
  const baseFee = db.calculatePaymentFee(nominal);
  const paymentAmount = db.calculatePaymentTotal(nominal);

  const msgLoading = await ctx.replyWithHTML(
    en
      ? `<blockquote>🔄 <b>Creating QRIS...</b></blockquote>`
      : `<blockquote>🔄 <b>Membuat QRIS...</b></blockquote>`
  ).catch(() => null);

  let qrisData;
  try {
    qrisData = await createPayment(paymentAmount, config, { orderId: depoId });
  } catch (e) {
    if (msgLoading) await bot.telegram.deleteMessage(ctx.chat.id, msgLoading.message_id).catch(() => {});
    return ctx.replyWithHTML(
      en
        ? `<blockquote>❌ <b>Failed to create QRIS.</b>\n\n${e.message}</blockquote>`
        : `<blockquote>❌ <b>Gagal membuat QRIS.</b>\n\n${e.message}</blockquote>`
    );
  }

  if (msgLoading) {
    await bot.telegram.deleteMessage(ctx.chat.id, msgLoading.message_id).catch(() => {});
  }

  if (!qrisData || (!qrisData.qris && !qrisData.qrBuffer && !qrisData.qrDataUrl)) {
    return ctx.replyWithHTML(
      en
        ? `<blockquote>❌ <b>Failed to create QRIS.</b>\n\nTry again later or contact admin.</blockquote>`
        : `<blockquote>❌ <b>Gagal membuat QRIS.</b>\n\nCoba beberapa saat lagi atau hubungi admin.</blockquote>`
    );
  }

  // Total gateway sudah mencakup nominal + fee admin + kode unik / fee PanzzPay.
  const finalPayAmount = Number(qrisData.totalAmount || qrisData.amount || paymentAmount);
  const providerFee = Number(qrisData.providerFee || qrisData.fee || 0);
  const displayFee = baseFee + providerFee;

  // Persiapkan QR image
  let qrBuffer = qrisData.qrBuffer || null;
  let qrImageSource = null; // bisa buffer atau URL

  if (!qrBuffer && typeof qrisData.qris === "string") {
    // Cek apakah URL gambar eksternal
    if (qrisData.qris.startsWith("http://") || qrisData.qris.startsWith("https://")) {
      qrImageSource = qrisData.qris;
    } else if (qrisData.qris.startsWith("data:image/")) {
      // Data URL base64 dari gateway
      try {
        const base64Data = qrisData.qris.replace(/^data:image\/\w+;base64,/, "");
        qrBuffer = Buffer.from(base64Data, "base64");
      } catch (e) {
        console.error("[PANZZPAY QR BUFFER ERROR]", e.message);
      }
    } else {
      // Payload teks QRIS standar (dimulai '000201...')
      try {
        qrBuffer = await QRCode.toBuffer(qrisData.qris, {
          type: "png", width: 400, margin: 2,
          color: { dark: "#000000", light: "#FFFFFF" },
        });
      } catch (e) {
        console.error("[QRCODE ERROR]", e.message);
      }
    }
  }

  const expiredStr = qrisData.expiredAt
    ? new Date(qrisData.expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    : (en ? "15 minutes" : "15 menit");

  const caption = en
? `💳 <b>AUTO QRIS PAYMENT (${qrisData.provider || "PanzzPay"})</b>

🆔 <b>Transaction ID:</b> <code>${qrisData.orderId}</code>
💰 <b>Deposit:</b> <b>${rupiah(nominal)}</b>
🧾 <b>fee:</b> <b>${rupiah(displayFee)}</b>
💳 <b>Total to pay:</b> <b>${rupiah(finalPayAmount)}</b>
⏰ <b>Expires:</b> ${expiredStr}

<b>Steps:</b>
1. Open your e-wallet (GoPay, OVO, DANA, etc.)
2. Tap Scan / QRIS
3. Scan the QR code above
4. Complete payment ✅

⚡ Payment will be verified automatically!`
: `💳 <b>PEMBAYARAN QRIS OTOMATIS (${qrisData.provider || "PanzzPay"})</b>

🆔 <b>ID Transaksi:</b> <code>${qrisData.orderId}</code>
💰 <b>Deposit:</b> <b>${rupiah(nominal)}</b>
🧾 <b>Fee:</b> <b>${rupiah(displayFee)}</b>
💳 <b>Total Bayar:</b> <b>${rupiah(finalPayAmount)}</b>
⏰ <b>Kadaluarsa:</b> ${expiredStr}

<b>Cara bayar:</b>
1. Buka aplikasi e-wallet kamu (GoPay, OVO, DANA, dll)
2. Pilih Scan / QRIS
3. Scan QR code di atas
4. Selesaikan pembayaran ✅

⚡ Pembayaran akan terverifikasi otomatis!`;

  const inlineKeyboard = [
    [{ text: en ? "❌ Cancel" : "❌ Batal", callback_data: `cancel_depo_${depoId}` }],
  ];

  let sentMsg = null;
  try {
    if (qrBuffer) {
      sentMsg = await ctx.replyWithPhoto(
        { source: qrBuffer, filename: "qris.png" },
        {
          caption,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: inlineKeyboard },
        }
      );
    } else if (qrImageSource) {
      sentMsg = await ctx.replyWithPhoto(
        qrImageSource,
        {
          caption,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: inlineKeyboard },
        }
      );
    } else {
      // fallback: kirim teks QRIS
      sentMsg = await ctx.replyWithHTML(
        caption + `\n\n<code>${qrisData.qris}</code>`,
        { reply_markup: { inline_keyboard: inlineKeyboard } }
      );
    }
  } catch (sendErr) {
    console.error("[REPLY QRIS ERROR]", sendErr.message);
    try {
      sentMsg = await ctx.replyWithHTML(
        caption + `\n\n<code>${qrisData.qris}</code>`,
        { reply_markup: { inline_keyboard: inlineKeyboard } }
      );
    } catch (fallbackErr) {
      console.error("[REPLY QRIS FALLBACK ERROR]", fallbackErr.message);
      sentMsg = await ctx.replyWithHTML(caption);
    }
  }

  // Simpan di DB
  db.addDepositAuto({
    depoId,
    userId:      uid,
    username:    ctx.from.username || ctx.from.first_name,
    nominal,
    paymentAmount: finalPayAmount,
    fee: displayFee,
    idtransaksi: qrisData.orderId,
    status:      "waiting_payment",
    chatId:      ctx.chat.id,
    msgId:       sentMsg?.message_id,
  });

  // Auto expire mengikuti expired_at dari PanzzPay bila tersedia.
  const providerExpiryMs = qrisData.expiresAtMs || (qrisData.expiredAt
    ? new Date(qrisData.expiredAt).getTime()
    : Date.now() + 15 * 60 * 1000);
  const expireDelayMs = Number.isFinite(providerExpiryMs)
    ? Math.max(1000, providerExpiryMs - Date.now())
    : 15 * 60 * 1000;
  const expireTimeout = setTimeout(async () => {
    const current = db.getDeposit(depoId);
    if (!current || current.status !== "waiting_payment") return;
    db.updateDeposit(depoId, "expired");
    if (db.getDeposit(depoId)?.status !== "expired") return;
    if (activeTransactions[uid]?.depoId === depoId) {
      clearInterval(activeTransactions[uid].interval);
      delete activeTransactions[uid];
    }
    if (sentMsg) {
      await bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(async () => {
        const expCaption = en
          ? `<blockquote>⌛ <b>Payment time has expired.</b>\n━━━━━━━━━━━━━━━━\n🆔 ID: <code>${qrisData.orderId}</code>\nTransaction expired automatically. Please retry.</blockquote>`
          : `<blockquote>⌛ <b>Waktu pembayaran habis.</b>\n━━━━━━━━━━━━━━━━\n🆔 ID: <code>${qrisData.orderId}</code>\nTransaksi otomatis kedaluwarsa. Silakan ulangi deposit.</blockquote>`;
        await bot.telegram.editMessageCaption(ctx.chat.id, sentMsg.message_id, null, expCaption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      });
    }
    await bot.telegram.sendMessage(uid,
      en
        ? `<blockquote>⌛ <b>Payment time has expired.</b>\n\nTransaction cancelled automatically. Please retry deposit.</blockquote>`
        : `<blockquote>⌛ <b>Waktu pembayaran habis.</b>\n\nTransaksi otomatis dibatalkan. Silakan ulangi deposit.</blockquote>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }, expireDelayMs);

  // Polling cek status cepat (default 3-5 detik sesuai dokumen PanzzPay)
  const pollIntervalMs = config.PANZZPAY?.pollIntervalMs || config.PAYMENT_GATEWAY?.pollIntervalMs || 4000;
  let isChecking = false;

  const interval = setInterval(async () => {
    if (isChecking) return;
    isChecking = true;

    try {
      const isPaid = await cekPaid({ orderId: qrisData.orderId }, config);

      if (isPaid) {
        clearInterval(interval);
        clearTimeout(expireTimeout);
        await handleDepositSuccess(depoId, "QRIS Otomatis (PanzzPay)");
      }
    } catch (e) {
      console.error("[CEK ERROR]", e.message);
    } finally {
      isChecking = false;
    }
  }, pollIntervalMs);

  activeTransactions[uid] = {
    depoId,
    interval,
    expireTimeout,
    msgId: sentMsg?.message_id,
    chatId: ctx.chat.id,
    orderId: qrisData.orderId,
  };
}

// ── Cancel QRIS aktif ─────────────────────────────────────
bot.action(/^cancel_depo_([^_]+)(?:_(.+))?$/, async (ctx) => {
  const depoId = ctx.match[1];
  await ctx.answerCbQuery();

  const dep = db.getDeposit(depoId);

  if (!dep || dep.status !== "waiting_payment") {
    return ctx.answerCbQuery(
      "❌ Transaksi tidak ditemukan atau sudah selesai.",
      { show_alert: true }
    );
  }

  const orderId = ctx.match[2] || dep.idtransaksi;

  try {
    const uid = dep.userId;
    db.updateDeposit(depoId, "cancelled");

    // Hentikan pengecekan transaksi
    if (activeTransactions[uid]?.depoId === depoId) {
      if (activeTransactions[uid].interval) clearInterval(activeTransactions[uid].interval);
      if (activeTransactions[uid].expireTimeout) clearTimeout(activeTransactions[uid].expireTimeout);
      delete activeTransactions[uid];
    }

    await cancelQris(orderId, config);
    const cancelCaption = `<blockquote>❌ <b>Deposit dibatalkan.</b>\n━━━━━━━━━━━━━━━━\n🆔 ID: <code>${orderId || depoId}</code></blockquote>`;

    // Hapus pesan QRIS sepenuhnya agar QR tidak bisa dipindai setelah batal.
    const qrMessageDeleted = await ctx.deleteMessage()
      .then(() => true)
      .catch(() => false);

    // Fallback bila Telegram menolak penghapusan pesan (misalnya pesan terlalu lama).
    if (!qrMessageDeleted) {
      await ctx.editMessageCaption(cancelCaption, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }).catch(async () => {
        await ctx.editMessageText(cancelCaption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      });
    }

  } catch (error) {
    console.error("Gagal membatalkan QRIS:", error);

    return ctx.answerCbQuery(
      "❌ Gagal membatalkan QRIS. Silakan coba lagi.",
      { show_alert: true }
    );
  }
});

// ── Tangkap semua foto ────────────────────────────────────
bot.on("photo", async (ctx) => {
  const uid  = ctx.from.id;
  const sess = sessions[uid];
  if (!sess) return;

  // ── Bukti deposit MANUAL ──────────────────────────────
  if (sess.step === "deposit_bukti") {
    sess.step      = "deposit_konfirmasi";
    const fotoId   = ctx.message.photo.at(-1).file_id;
    const username = ctx.from.username || ctx.from.first_name;
    const depId    = db.addDeposit({ userId: uid, username, nominal: sess.nominal, fotoId });
    sess.depId     = depId;

    await ctx.deleteMessage().catch(() => {});

    const konfirmMsg = await ctx.replyWithHTML(
      "<blockquote>📨 <b>Bukti deposit diterima!</b>\n⏳ Menunggu konfirmasi admin...</blockquote>"
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, konfirmMsg.message_id).catch(() => {}), 30000);

    try {
      await bot.telegram.sendPhoto(config.OWNER_ID, fotoId, {
        caption:
`<blockquote>💰 <b>REQUEST DEPOSIT MANUAL</b>
━━━━━━━━━━━━━━━━
👤 User    : @${escapeHTML(username)} (<code>${uid}</code>)
🪙 Nominal : <b>${rupiah(sess.nominal)}</b>
🆔 DEP ID  : <code>${depId}</code>
━━━━━━━━━━━━━━━━</blockquote>`,
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Setujui", `depok_${depId}`),
           Markup.button.callback("❌ Tolak",   `depno_${depId}`)],
        ]).reply_markup,
      });
    } catch (e) {
      console.error("Forward deposit owner:", e.message);
    }
    return;
  }

  // ── Bukti beli nokos ──────────────────────────────────
  if (sess.step === "menunggu_bukti") {
    sess.step          = "menunggu_konfirmasi";
    sess.buktiFotoId   = ctx.message.photo.at(-1).file_id;
    sess.buyerUsername = ctx.from.username || ctx.from.first_name;
    sess.buyerId       = uid;

    await ctx.deleteMessage().catch(() => {});

    const waitMsg = await ctx.replyWithHTML(
      "<blockquote>📨 <b>Bukti diterima!</b>\n⏳ Menunggu konfirmasi admin...</blockquote>"
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {}), 30000);

    try {
      await bot.telegram.sendPhoto(config.OWNER_ID, sess.buktiFotoId, {
        caption:
`<blockquote>🔔 <b>BUKTI BAYAR NOKOS</b>
━━━━━━━━━━━━━━━━
👤 User   : @${escapeHTML(sess.buyerUsername)} (<code>${uid}</code>)
🌍 Negara : <b>${escapeHTML(sess.countryName)}</b>
💰 Harga  : <b>${rupiah(sess.hargaUser)}</b>
━━━━━━━━━━━━━━━━</blockquote>`,
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Setujui", `ok_${uid}`),
           Markup.button.callback("❌ Tolak",   `no_${uid}`)],
        ]).reply_markup,
      });
    } catch (e) {
      console.error("Forward nokos owner:", e.message);
      ctx.reply(`❌ Gagal kirim ke admin. Hubungi: ${config.urladmin}`);
    }
    return;
  }
});

// ── Owner: ACC Deposit MANUAL ─────────────────────────────
bot.action(/^depok_(.+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Bukan owner!", { show_alert: true });
  await ctx.answerCbQuery("✅ Disetujui!");

  const depId = ctx.match[1];
  const dep   = db.getDeposit(depId);

  if (!dep || dep.status !== "pending") {
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  db.updateDeposit(depId, "approved");
  const newCoin = db.addCoin(dep.userId, dep.nominal);

  // Proses Komisi Referral Deposit
  try {
    const refResult = db.processDepositReferralCommission(dep.userId, dep.nominal);
    if (refResult.rewarded) {
      await bot.telegram.sendMessage(
        refResult.inviterId,
        `<blockquote>🎉 <b>KOMISI REFERRAL MASUK!</b>
━━━━━━━━━━━━━━━━
Teman yang kamu undang (<b>@${escapeHTML(refResult.depositorUsername)}</b>) baru saja melakukan deposit sebesar <b>${rupiah(refResult.depositAmount)}</b>.

🪙 Komisi kamu (${refResult.percent}%): <b>+${rupiah(refResult.commission)}</b>
💰 Saldo kamu sekarang: <b>${rupiah(db.getCoin(refResult.inviterId))}</b>
━━━━━━━━━━━━━━━━
Terus bagikan link referral kamu dan raih komisi pasif tanpa batas! 🚀</blockquote>`,
        { parse_mode: "HTML" }
      ).catch(() => {});

      sendChannelReferralCommissionNotification({
        inviterUsername: refResult.inviterUsername,
        depositorUsername: refResult.depositorUsername,
        depositAmount: refResult.depositAmount,
        commission: refResult.commission,
        percent: refResult.percent,
      });
    }
  } catch (err) {
    console.error("[REFERRAL MANUAL DEPOSIT ERROR]", err.message);
  }

  await ctx.deleteMessage().catch(() => {});

  await bot.telegram.sendMessage(dep.userId,
`<blockquote>✅ <b>DEPOSIT DISETUJUI!</b>
━━━━━━━━━━━━━━━━
🪙 Ditambahkan : <b>${rupiah(dep.nominal)}</b>
💰 Coin kamu   : <b>${rupiah(newCoin)}</b>
━━━━━━━━━━━━━━━━
Silakan mulai beli nokos! 🚀</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});

  if (sessions[dep.userId]?.step === "deposit_konfirmasi") {
    delete sessions[dep.userId];
  }
});

// ── Owner: Tolak Deposit MANUAL ───────────────────────────
bot.action(/^depno_(.+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Bukan owner!", { show_alert: true });
  await ctx.answerCbQuery("❌ Ditolak!");

  const depId = ctx.match[1];
  const dep   = db.getDeposit(depId);

  if (!dep) { await ctx.deleteMessage().catch(() => {}); return; }

  db.updateDeposit(depId, "rejected");
  await ctx.deleteMessage().catch(() => {});

  await bot.telegram.sendMessage(dep.userId,
`<blockquote>❌ <b>DEPOSIT DITOLAK</b>
Bukti tidak valid / nominal tidak sesuai.
💬 Hubungi: ${config.urladmin}</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});

  if (sessions[dep.userId]?.step === "deposit_konfirmasi") {
    delete sessions[dep.userId];
  }
});

// ── Notifikasi Deposit ke Owner ───────────────────────────
async function sendDepositNotification({ userId, userName, userUsername, nominal, saldoSebelum, saldoSekarang, depoId, metode }) {
  try {
    await bot.telegram.sendMessage(config.OWNER_ID,
`<blockquote>💰 <b>DEPOSIT MASUK!</b>
━━━━━━━━━━━━━━━━
👤 User     : @${escapeHTML(userUsername)} (<code>${userId}</code>)
📛 Nama     : ${escapeHTML(userName)}
💵 Metode   : ${metode || "QRIS Otomatis"}
🪙 Nominal  : <b>${rupiah(nominal)}</b>
📊 Saldo    : ${rupiah(saldoSebelum)} → <b>${rupiah(saldoSekarang)}</b>
🆔 ID       : <code>${depoId}</code>
🕐 Waktu    : ${getWaktu()}
━━━━━━━━━━━━━━━━</blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[NOTIF OWNER ERROR]", e.message);
  }
}

// ── 🛒 Beli Nokos → Pilih Layanan WAHUB ───────────────────
bot.hears("🛒 Beli Nokos", showServerChoice);
bot.command("buynokos", showServerChoice);

async function showActiveOrdersPrompt(ctx, uid, activeOrders) {
  const lines = activeOrders.map((order, index) => {
    const sisaMs = Math.max(0, (order.expiresAt || 0) - Date.now());
    const sisaMin = Math.floor(sisaMs / 60000);
    const sisaSec = Math.floor((sisaMs % 60000) / 1000);
    const sisaText = `${sisaMin}m ${sisaSec}s`;
    return (
      `📱 <b>Nomor ${index + 1}:</b> <code>${escapeHTML(order.phone || "-")}</code>\n` +
      `   🔧 Layanan: <b>${escapeHTML(order.serviceName || "-")}</b> | 💰 ${rupiah(order.hargaUser)}\n` +
      `   ⏳ Sisa waktu: <i>${sisaText}</i>`
    );
  });

  const text = `<blockquote>⚠️ <b>KAMU MEMILIKI ORDER AKTIF (${activeOrders.length}/${MAX_WAHUB_SESSIONS})</b>
━━━━━━━━━━━━━━━━
${lines.join("\n\n")}
━━━━━━━━━━━━━━━━
💡 Kamu bisa batalkan order di bawah ini (saldo di-refund 100%) atau lanjut beli nomor baru jika slot tersedia.</blockquote>`;

  const keyboardButtons = [];
  const unfulfilledOrders = activeOrders.filter((o) => !(o.hasReceivedOtp || isWahubPaidSession(o)));
  activeOrders.forEach((order, index) => {
    const key = order.sessionKey || order.trxId || order.orderId;
    const label = shortButtonText(order.phone || order.serviceName || `Nomor ${index + 1}`, 15);
    const hasAlreadyReceivedOtp = Boolean(order.hasReceivedOtp || order.firstOtp || order.lastOtp || isWahubPaidSession(order));
    if (hasAlreadyReceivedOtp) {
      keyboardButtons.push([
        Markup.button.callback(`🔁 Minta OTP (${wahubRetryCount(order)}/3)`, `wahub_retry_${uid}_${key}`),
        Markup.button.callback(`✅ Selesai ${label}`, `order_done_${uid}_${key}`),
      ]);
    } else {
      keyboardButtons.push([
        Markup.button.callback(`🔁 Minta OTP (${wahubRetryCount(order)}/3)`, `wahub_retry_${uid}_${key}`),
        Markup.button.callback(`🔄 Ganti Nomor`, `wahub_change_num_${uid}_${key}`),
        Markup.button.callback(`🚫 Batalkan ${label}`, `wahub_cancel_${uid}_${key}`),
      ]);
    }
  });

  if (unfulfilledOrders.length > 1) {
    keyboardButtons.push([Markup.button.callback("🚫 Batalkan SEMUA Order (Belum Ada OTP)", `wahub_cancel_all_${uid}`)]);
  }

  if (activeOrders.length < MAX_WAHUB_SESSIONS) {
    keyboardButtons.push([Markup.button.callback(`➕ Beli Nomor Baru (${activeOrders.length}/${MAX_WAHUB_SESSIONS})`, `wahub_force_new_${uid}`)]);
  }

  keyboardButtons.push([Markup.button.callback("⬅️ Menu Utama", `wahub_back_main_${uid}`)]);

  return ctx.replyWithHTML(text, Markup.inlineKeyboard(keyboardButtons));
}

async function showServerChoice(ctx) {
  const uid = ctx.from.id;
  const activeOrders = getActiveWahubSessions(uid);
  if (activeOrders.length > 0) {
    return showActiveOrdersPrompt(ctx, uid, activeOrders);
  }

  const text = `<blockquote>🛒 <b>PILIH KATEGORI NOKOS</b>
━━━━━━━━━━━━━━━━
Silakan pilih kategori verifikasi nomor virtual yang kamu butuhkan:

🟢 <b>OTP via WhatsApp</b>
   Nomor khusus verifikasi akun WhatsApp (Server 1⃣ & Server 2⃣)

✉️ <b>OTP via SMS</b>
   Nomor virtual verifikasi SMS berbagai aplikasi (Server 1⃣ & Server 2⃣)
━━━━━━━━━━━━━━━━
💡 Pilih kategori di bawah ini:</blockquote>`;

  const keyboardButtons = [
    [Markup.button.callback("🟢 OTP via WhatsApp", `choose_cat_wa_${uid}`)],
    [Markup.button.callback("✉️ OTP via SMS", `choose_cat_sms_${uid}`)],
    [Markup.button.callback("⬅️ Menu Utama", `wahub_back_main_${uid}`)],
  ];

  sessions[uid] = { step: "pilih_kategori" };
  if (ctx.callbackQuery?.message?.message_id) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      text,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(keyboardButtons).reply_markup }
    ).catch(() => ctx.replyWithHTML(text, Markup.inlineKeyboard(keyboardButtons)));
  }
  return ctx.replyWithHTML(text, Markup.inlineKeyboard(keyboardButtons));
}

async function showWhatsappServerChoice(ctx, uid) {
  const s1Status = db.getProviderStatus("wahub");
  const s2Status = db.getProviderStatus("engineunicorn");

  if (!s1Status && !s2Status) {
    return ctx.replyWithHTML(
      "<blockquote>⚠️ <b>LAYANAN NOKOS WHATSAPP TUTUP</b>\n\nSemua server penyedia WhatsApp saat ini sedang dalam pemeliharaan atau dinonaktifkan oleh admin. Silakan coba lagi nanti.</blockquote>"
    );
  }

  const text = `<blockquote>🟢 <b>PILIH SERVER — OTP WHATSAPP</b>
━━━━━━━━━━━━━━━━
Silakan pilih server penyedia nomor:

<b>Server 1⃣</b>
   Status: ${s1Status ? "🟢 <b>Aktif</b>" : "🔴 <i>Tutup</i>"}

<b>Server 2⃣</b>
   Status: ${s2Status ? "🟡 <b>Aktif</b>" : "🔴 <i>Tutup</i>"}
━━━━━━━━━━━━━━━━
💡 Pilih server di bawah ini untuk melihat daftar layanan dan stok:</blockquote>`;

  const keyboardButtons = [
    [
      Markup.button.callback(
        `${s1Status ? "🟢" : "🔴"} Server 1⃣`,
        `choose_server_1_${uid}`
      ),
      Markup.button.callback(
        `${s2Status ? "🟡" : "🔴"} Server 2⃣`,
        `choose_server_2_${uid}`
      ),
    ],
    [Markup.button.callback("⬅️ Kembali ke Kategori", `back_to_category_choice_${uid}`)],
  ];

  sessions[uid] = { step: "pilih_server_wa" };
  if (ctx.callbackQuery?.message?.message_id) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      text,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(keyboardButtons).reply_markup }
    ).catch(() => ctx.replyWithHTML(text, Markup.inlineKeyboard(keyboardButtons)));
  }
  return ctx.replyWithHTML(text, Markup.inlineKeyboard(keyboardButtons));
}

async function showSmsServerChoice(ctx, uid) {
  const s1Status = db.getProviderStatus("fastbit");
  const s2Status = db.getProviderStatus("rumahotp");

  if (!s1Status && !s2Status) {
    return ctx.replyWithHTML(
      "<blockquote>⚠️ <b>LAYANAN NOKOS SMS TUTUP</b>\n\nSemua metode verifikasi SMS saat ini sedang dalam pemeliharaan atau dinonaktifkan oleh admin. Silakan coba lagi nanti.</blockquote>"
    );
  }

  const text = `<blockquote>✉️ <b>PILIH SERVER — OTP SMS</b>
━━━━━━━━━━━━━━━━
Silakan pilih server verifikasi yang diinginkan:

<b>Server 1⃣ — SMS Biasa</b>
   Status: ${s1Status ? "🟢 <b>Aktif</b>" : "🔴 <i>Tutup</i>"}
   Metode: SMS Otomatis

<b>Server 2⃣ — FlashCall + SMS</b>
   Status: ${s2Status ? "🟡 <b>Aktif</b>" : "🔴 <i>Tutup</i>"}
   Metode: FlashCall & SMS (Kode via Panggilan / SMS)
━━━━━━━━━━━━━━━━
💡 Pilih server di bawah ini untuk melihat daftar layanan dan stok:</blockquote>`;

  const keyboardButtons = [
    [
      Markup.button.callback(
        `${s1Status ? "🟢" : "🔴"} Server 1⃣ (SMS)`,
        `choose_sms_server_1_${uid}`
      ),
      Markup.button.callback(
        `${s2Status ? "🟡" : "🔴"} Server 2⃣ (FlashCall)`,
        `choose_sms_server_2_${uid}`
      ),
    ],
    [Markup.button.callback("⬅️ Kembali ke Kategori", `back_to_category_choice_${uid}`)],
  ];

  sessions[uid] = { step: "pilih_server_sms" };
  if (ctx.callbackQuery?.message?.message_id) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      text,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(keyboardButtons).reply_markup }
    ).catch(() => ctx.replyWithHTML(text, Markup.inlineKeyboard(keyboardButtons)));
  }
  return ctx.replyWithHTML(text, Markup.inlineKeyboard(keyboardButtons));
}

bot.action(/^choose_cat_wa_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await showWhatsappServerChoice(ctx, uid);
});

bot.action(/^choose_cat_sms_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await showSmsServerChoice(ctx, uid);
});

bot.action(/^back_to_category_choice_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await showServerChoice(ctx);
});

bot.action(/^choose_server_1_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (!db.getProviderStatus("wahub")) {
    return ctx.answerCbQuery("⚠️ Server 1 sedang dinonaktifkan oleh admin.", { show_alert: true });
  }
  await ctx.answerCbQuery("⏳ Memuat layanan Server 1...");
  const services = (await wahub.getServices()).filter((service) => service.stock > 0);
  if (!services.length) {
    return ctx.replyWithHTML(
      `<blockquote>⚠️ <b>Layanan Server 1 sedang tidak tersedia.</b>\n${escapeHTML(wahub.getLastError() || "Stok sedang habis, coba lagi nanti.")}</blockquote>`
    );
  }
  sessions[uid] = { step: "wahub_pilih_service", wahubServices: services, servicePage: 1 };
  return showWahubServices(ctx, uid, ctx.callbackQuery?.message?.message_id);
});

bot.action(/^choose_server_2_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (!db.getProviderStatus("engineunicorn")) {
    return ctx.answerCbQuery("⚠️ Server 2 sedang dinonaktifkan oleh admin.", { show_alert: true });
  }
  await ctx.answerCbQuery("⏳ Memuat layanan Server 2...");
  const services = (await engineunicorn.getServices()).filter((service) => service.stock > 0);
  if (!services.length) {
    return ctx.replyWithHTML(
      `<blockquote>⚠️ <b>Layanan Server 2 sedang tidak tersedia.</b>\n${escapeHTML(engineunicorn.getLastError() || "Stok sedang habis, coba lagi nanti.")}</blockquote>`
    );
  }
  sessions[uid] = { step: "eu_pilih_service", euServices: services, servicePage: 1 };
  return showEngineUnicornServices(ctx, uid, ctx.callbackQuery?.message?.message_id);
});

bot.action(/^choose_sms_server_1_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (!db.getProviderStatus("fastbit")) {
    return ctx.answerCbQuery("⚠️ Server 1 (SMS) sedang dinonaktifkan oleh admin.", { show_alert: true });
  }
  await ctx.answerCbQuery("⏳ Memuat layanan Server 1 (SMS)...");
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat layanan Server 1 (SMS)...</i></blockquote>");
  const services = await fastbit.getServices();
  if (!services.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ <b>Layanan tidak tersedia.</b>\n${escapeHTML(fastbit.getLastError() || "Daftar layanan sedang tidak tersedia.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }
  sessions[uid] = {
    step: "fb_pilih_service",
    server: "fastbit",
    smsServer: 1,
    verificationType: "sms",
    serverLabel: "Server 1⃣ (SMS)",
    fastbitServices: services,
    servicePage: 1,
  };
  await showFastbitServices(ctx, uid, loadMsg.message_id);
});

bot.action(/^choose_sms_server_2_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (!db.getProviderStatus("rumahotp")) {
    return ctx.answerCbQuery("⚠️ Server 2 (FlashCall) sedang dinonaktifkan oleh admin.", { show_alert: true });
  }
  await ctx.answerCbQuery("⏳ Memuat layanan Server 2 (FlashCall + SMS)...");
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat layanan Server 2 (FlashCall + SMS)...</i></blockquote>");
  const services = await herosms.getServices();
  if (!services.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ <b>Layanan tidak tersedia.</b>\n${escapeHTML(herosms.getLastError() || "Daftar layanan Server 2 sedang tidak tersedia.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }
  sessions[uid] = {
    step: "hs_pilih_service",
    server: "herosms",
    smsServer: 2,
    verificationType: "flashcall",
    serverLabel: "Server 2⃣ (FlashCall + SMS)",
    heroServices: services,
    servicePage: 1,
  };
  await showHeroServices(ctx, uid, loadMsg.message_id);
});

bot.action(/^back_to_server_choice_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  return showWhatsappServerChoice(ctx, uid);
});

async function showWahubServices(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const services = sess?.wahubServices || [];
  const totalPage = Math.max(1, Math.ceil(services.length / WA_SERVICE_PAGE_SIZE));
  const page = Math.min(Math.max(sess.servicePage || 1, 1), totalPage);
  sess.servicePage = page;
  const start = (page - 1) * WA_SERVICE_PAGE_SIZE;
  const items = services.slice(start, start + WA_SERVICE_PAGE_SIZE);
  const buttons = threeColumnButtons(items, (service, index) => {
    return Markup.button.callback(
      shortButtonText(service.name, 14),
      `wahub_svc_${start + index}_${uid}`
    );
  });
  addPageButtons(
    buttons,
    page,
    totalPage,
    `wahub_service_pg_${uid}_${page - 1}`,
    `wahub_service_pg_${uid}_${page + 1}`,
    `back_to_server_choice_${uid}`
  );

  const text = `<blockquote>🛒 <b>SERVER 1</b>
━━━━━━━━━━━━━━━━
Pilih layanan OTP yang diinginkan.
Harga sudah termasuk biaya layanan.
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, options).catch(() => ctx.replyWithHTML(text, options));
  return ctx.replyWithHTML(text, { reply_markup: options.reply_markup });
}

async function createWahubOrder(ctx, uid, fresh) {
  await db.syncUser(uid);
  const price = db.calculatePrice("wahub", fresh.price, fresh.id, uid);
  const coin = db.getCoin(uid);
  if (coin < price) {
    return ctx.replyWithHTML(
      `<blockquote>❌ <b>COIN TIDAK CUKUP</b>
💰 Harga: <b>${rupiah(price)}</b>
🪙 Coin kamu: <b>${rupiah(coin)}</b>
⚠️ Kurang: <b>${rupiah(price - coin)}</b>

Silakan deposit coin terlebih dahulu.</blockquote>`,
      Markup.inlineKeyboard([[Markup.button.callback("🪙 Deposit", `metode_auto_${uid}`)]])
    );
  }
  const deducted = db.deductCoin(uid, price);
  if (deducted === false) return ctx.reply("❌ Saldo berubah. Silakan coba lagi.");
  await db.persistUser(uid);
  const loadMsg = await ctx.replyWithHTML("<blockquote>⏳ <b>Memproses order...</b></blockquote>").catch(() => null);
  let order = null;
  try {
    order = await wahub.rent(fresh.id);
  } catch (err) {
    console.error("wahub.rent error:", err.message);
  }
  if (!order?.order_id || !order.token || !order.phone) {
    db.addCoin(uid, price);
    await db.persistUser(uid);
    const failText = `<blockquote>❌ <b>Order gagal.</b> Coin sudah dikembalikan.
${escapeHTML(wahub.getLastError() || "Stok tidak tersedia.")}</blockquote>`;
    if (loadMsg?.message_id) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, loadMsg.message_id, null,
        failText,
        { parse_mode: "HTML" }
      ).catch(() => ctx.replyWithHTML(failText));
    }
    return ctx.replyWithHTML(failText);
  }
  const trxId = db.addTransaction({
    userId: uid, username: ctx.from.username || ctx.from.first_name,
    orderId: order.order_id, phone: order.phone, productName: fresh.name,
    negara: "Indonesia", harga: price, provider: "wahub",
    serviceId: fresh.id, providerPrice: fresh.price,
  });
  const expiryMs = Date.now() + OTP_WAIT_MS;
  const active = {
    step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
    createdAt: new Date().toISOString(), serviceId: fresh.id,
    serviceName: fresh.name, hargaUser: price, orderId: order.order_id,
    token: order.token, phone: order.phone, expiresAt: expiryMs,
    cancelAt: 0, retryCount: 0, trxId,
    sessionKey: trxId,
    userId: uid,
    username: ctx.from.username || ctx.from.first_name || "",
    provider: "wahub",
    providerPrice: fresh.price,
    testimoniData: {
      username: ctx.from.username || ctx.from.first_name, phone: order.phone,
      negara: fresh.name, harga: price, trxId,
    },
  };
  wahubSessionDb.set(uid, active);
  const expiryText = new Date(expiryMs).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const successText = `<blockquote>✅ <b>ORDER BERHASIL!</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(fresh.name)}</b>
📱 Nomor: <code>${escapeHTML(order.phone)}</code>
💰 Harga: <b>${rupiah(price)}</b>
🪙 Sisa coin: <b>${rupiah(deducted)}</b>
🧾 TRX ID: <code>${trxId || "-"}</code>
⏰ Berakhir: <i>${expiryText}</i>
━━━━━━━━━━━━━━━━
⏳ Menunggu OTP masuk...

💡 Kamu bisa batalkan order kapan saja jika OTP tidak masuk (Saldo di-refund 100%).</blockquote>`;
  active.orderMsgId = await updateOrderMessage(ctx, loadMsg, successText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔁 Minta Ulang OTP (0/3)", callback_data: `wahub_retry_${uid}_${trxId}` }],
        [{ text: "🔄 Ganti Nomor", callback_data: `wahub_change_num_${uid}_${trxId}` }],
        [{ text: "🚫 Batalkan Order", callback_data: `wahub_cancel_${uid}_${trxId}` }],
      ],
    },
  });
  wahubSessionDb.set(uid, active);
  pollWahub(uid, trxId);
}

bot.action(/^wahub_service_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  let sess = sessions[uid];
  if (!sess || !sess.wahubServices?.length) {
    const services = (await wahub.getServices()).filter((service) => service.stock > 0);
    if (!services.length) {
      return ctx.replyWithHTML(
        `<blockquote>⚠️ <b>Layanan sedang tidak tersedia.</b>\n${escapeHTML(wahub.getLastError() || "Stok sedang habis, coba lagi nanti.")}</blockquote>`
      );
    }
    sess = { step: "wahub_pilih_service", wahubServices: services, servicePage: 1 };
    sessions[uid] = sess;
  }
  sess.step = "wahub_pilih_service";
  sess.servicePage = parseInt(ctx.match[2]);
  await showWahubServices(ctx, uid, ctx.callbackQuery?.message?.message_id);
});

bot.action(/^wahub_back_main_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  delete sessions[uid];
  await ctx.deleteMessage().catch(() => {});
  await showMainMenu(ctx, uid);
});

bot.action(/^wahub_svc_(\d+)_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (wahubSessionLimitReached(uid)) {
    return ctx.answerCbQuery(
      `⚠️ Batas sessions order tercapai (maksimal ${MAX_WAHUB_SESSIONS}).`,
      { show_alert: true }
    );
  }
  await ctx.answerCbQuery();
  const sess = sessions[uid];
  const selected = sess?.wahubServices?.[parseInt(ctx.match[1])];
  if (!sess || !selected) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos.");
  }

  const fresh = (await wahub.getServices()).find((service) => service.id === selected.id);
  if (!fresh || fresh.stock <= 0) {
    return ctx.answerCbQuery("❌ Stok layanan ini sedang habis.", { show_alert: true });
  }

  const priceDetails = db.getResellerPriceDetails("wahub", fresh.price, fresh.id, uid);
  const price = priceDetails.finalPrice;
  const coin = db.getCoin(uid);
  sess.step = "wahub_konfirmasi";
  sess.selectedService = fresh;

  const priceLabel = priceDetails.isReseller && priceDetails.discountAmount > 0
    ? `<s>${rupiah(priceDetails.normalPrice)}</s> <b>${rupiah(price)}</b> (⭐ Hemat ${rupiah(priceDetails.discountAmount)} Reseller)`
    : `<b>${rupiah(price)}</b>`;

  const page = sess.servicePage || 1;
  const confirmText = `<blockquote>📱 <b>KONFIRMASI ORDER NOKOS</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(fresh.name)}</b>
🌍 Negara: <b>Indonesia</b>
📦 Stok Tersedia: <b>${Number(fresh.stock || 0).toLocaleString("id-ID")} pcs</b>
💰 Harga: ${priceLabel}
🪙 Coin Kamu: <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Coin akan dipotong setelah kamu menekan tombol <b>Beli Sekarang</b>.</blockquote>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🛒 Beli Sekarang", `wahub_buy_${fresh.id}_${uid}`)],
    [Markup.button.callback("⬅️ Kembali ke Daftar", `wahub_service_pg_${uid}_${page}`)],
  ]);

  if (ctx.callbackQuery?.message?.message_id) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      confirmText,
      { parse_mode: "HTML", reply_markup: keyboard.reply_markup }
    ).catch(() => ctx.replyWithHTML(confirmText, keyboard));
  }
  return ctx.replyWithHTML(confirmText, keyboard);
});

const buyLocks = new Set();

bot.action(/^wahub_buy_(\d+)_(\d+)$/, async (ctx) => {
  const serviceId = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (buyLocks.has(uid)) {
    return ctx.answerCbQuery("⏳ Order sedang diproses, mohon tunggu sebentar...", { show_alert: true });
  }
  if (wahubSessionLimitReached(uid)) {
    return ctx.answerCbQuery(
      `⚠️ Batas sessions order tercapai (maksimal ${MAX_WAHUB_SESSIONS}).`,
      { show_alert: true }
    );
  }
  buyLocks.add(uid);
  try {
    await ctx.answerCbQuery("⏳ Memproses order...");

    const fresh = (await wahub.getServices()).find((service) => String(service.id) === String(serviceId));
    if (!fresh || fresh.stock <= 0) {
      return ctx.answerCbQuery("❌ Stok layanan ini baru saja habis.", { show_alert: true });
    }

    return await createWahubOrder(ctx, uid, fresh);
  } finally {
    setTimeout(() => buyLocks.delete(uid), 1500);
  }
});

// ── Server 2: EngineUnicorn flow ──────────────────────────
async function showEngineUnicornServices(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const services = sess?.euServices || [];
  const totalPage = Math.max(1, Math.ceil(services.length / WA_SERVICE_PAGE_SIZE));
  const page = Math.min(Math.max(sess.servicePage || 1, 1), totalPage);
  sess.servicePage = page;
  const start = (page - 1) * WA_SERVICE_PAGE_SIZE;
  const items = services.slice(start, start + WA_SERVICE_PAGE_SIZE);
  const buttons = threeColumnButtons(items, (service, index) => {
    return Markup.button.callback(
      shortButtonText(service.name, 14),
      `eu_svc_${start + index}_${uid}`
    );
  });
  addPageButtons(
    buttons,
    page,
    totalPage,
    `eu_service_pg_${uid}_${page - 1}`,
    `eu_service_pg_${uid}_${page + 1}`,
    `back_to_server_choice_${uid}`
  );

  const text = `<blockquote>🛒 <b>SERVER 2</b>
━━━━━━━━━━━━━━━━
Pilih layanan OTP yang diinginkan.
Harga sudah termasuk biaya layanan.
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, options).catch(() => ctx.replyWithHTML(text, options));
  return ctx.replyWithHTML(text, { reply_markup: options.reply_markup });
}

async function createEngineUnicornOrder(ctx, uid, fresh) {
  await db.syncUser(uid);
  const price = db.calculatePrice("engineunicorn", fresh.price, fresh.id, uid);
  const coin = db.getCoin(uid);
  if (coin < price) {
    return ctx.replyWithHTML(
      `<blockquote>❌ <b>COIN TIDAK CUKUP</b>
💰 Harga: <b>${rupiah(price)}</b>
🪙 Coin kamu: <b>${rupiah(coin)}</b>
⚠️ Kurang: <b>${rupiah(price - coin)}</b>

Silakan deposit coin terlebih dahulu.</blockquote>`,
      Markup.inlineKeyboard([[Markup.button.callback("🪙 Deposit", `metode_auto_${uid}`)]])
    );
  }
  const deducted = db.deductCoin(uid, price);
  if (deducted === false) return ctx.reply("❌ Saldo berubah. Silakan coba lagi.");
  await db.persistUser(uid);
  const loadMsg = await ctx.replyWithHTML("<blockquote>⏳ <b>Memproses order ke Server 2...</b></blockquote>").catch(() => null);
  let order = null;
  try {
    order = await engineunicorn.rent(fresh.id);
  } catch (err) {
    console.error("engineunicorn.rent error:", err.message);
  }
  if (!order?.order_id || !order.phone) {
    db.addCoin(uid, price);
    await db.persistUser(uid);
    const failText = `<blockquote>❌ <b>Order Server 2 gagal.</b> Coin sudah dikembalikan.
${escapeHTML(engineunicorn.getLastError() || "Stok tidak tersedia atau saldo penyedia tidak cukup.")}</blockquote>`;
    if (loadMsg?.message_id) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, loadMsg.message_id, null,
        failText,
        { parse_mode: "HTML" }
      ).catch(() => ctx.replyWithHTML(failText));
    }
    return ctx.replyWithHTML(failText);
  }
  const trxId = db.addTransaction({
    userId: uid, username: ctx.from.username || ctx.from.first_name,
    orderId: order.order_id, phone: order.phone, productName: fresh.name,
    negara: "Indonesia", harga: price, provider: "engineunicorn",
    serviceId: fresh.id, providerPrice: fresh.price,
  });
  const expiryMs = wahubExpiryMs(order.expires_at);
  const active = {
    step: "tunggu_otp", status: "waiting", providerStatus: "waiting",
    provider: "engineunicorn",
    createdAt: new Date().toISOString(), serviceId: fresh.id,
    serviceName: fresh.name, hargaUser: price, orderId: order.order_id,
    token: order.token || order.order_id, phone: order.phone, expiresAt: expiryMs,
    cancelAt: 0, retryCount: 0, trxId,
    sessionKey: trxId,
    userId: uid,
    username: ctx.from.username || ctx.from.first_name || "",
    providerPrice: fresh.price,
    testimoniData: {
      username: ctx.from.username || ctx.from.first_name, phone: order.phone,
      negara: fresh.name, harga: price, trxId,
    },
  };
  wahubSessionDb.set(uid, active);
  const expiryText = new Date(expiryMs).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const successText = `<blockquote>✅ <b>ORDER BERHASIL! (SERVER 2)</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(fresh.name)}</b>
📱 Nomor: <code>${escapeHTML(order.phone)}</code>
💰 Harga: <b>${rupiah(price)}</b>
🪙 Sisa coin: <b>${rupiah(deducted)}</b>
🧾 TRX ID: <code>${trxId || "-"}</code>
⏰ Berakhir: <i>${expiryText}</i>
━━━━━━━━━━━━━━━━
⏳ Menunggu OTP masuk...

💡 Kamu bisa batalkan order kapan saja jika OTP tidak masuk (Saldo di-refund 100%).</blockquote>`;
  active.orderMsgId = await updateOrderMessage(ctx, loadMsg, successText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔁 Minta Ulang OTP (0/3)", callback_data: `wahub_retry_${uid}_${trxId}` }],
        [{ text: "🔄 Ganti Nomor", callback_data: `wahub_change_num_${uid}_${trxId}` }],
        [{ text: "🚫 Batalkan Order", callback_data: `wahub_cancel_${uid}_${trxId}` }],
      ],
    },
  });
  wahubSessionDb.set(uid, active);
  pollWahub(uid, trxId);
}

bot.action(/^eu_service_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  let sess = sessions[uid];
  if (!sess || !sess.euServices?.length) {
    const services = (await engineunicorn.getServices()).filter((service) => service.stock > 0);
    if (!services.length) {
      return ctx.replyWithHTML(
        `<blockquote>⚠️ <b>Layanan sedang tidak tersedia.</b>\n${escapeHTML(engineunicorn.getLastError() || "Stok sedang habis, coba lagi nanti.")}</blockquote>`
      );
    }
    sess = { step: "eu_pilih_service", euServices: services, servicePage: 1 };
    sessions[uid] = sess;
  }
  sess.step = "eu_pilih_service";
  sess.servicePage = parseInt(ctx.match[2]);
  await showEngineUnicornServices(ctx, uid, ctx.callbackQuery?.message?.message_id);
});

bot.action(/^eu_svc_(\d+)_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (wahubSessionLimitReached(uid)) {
    return ctx.answerCbQuery(
      `⚠️ Batas sessions order tercapai (maksimal ${MAX_WAHUB_SESSIONS}).`,
      { show_alert: true }
    );
  }
  await ctx.answerCbQuery();
  const sess = sessions[uid];
  const selected = sess?.euServices?.[parseInt(ctx.match[1])];
  if (!sess || !selected) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos.");
  }

  const fresh = (await engineunicorn.getServices()).find((service) => service.id === selected.id);
  if (!fresh || fresh.stock <= 0) {
    return ctx.answerCbQuery("❌ Stok layanan ini sedang habis.", { show_alert: true });
  }

  const priceDetails = db.getResellerPriceDetails("engineunicorn", fresh.price, fresh.id, uid);
  const price = priceDetails.finalPrice;
  const coin = db.getCoin(uid);
  sess.step = "eu_konfirmasi";
  sess.selectedService = fresh;

  const priceLabel = priceDetails.isReseller && priceDetails.discountAmount > 0
    ? `<s>${rupiah(priceDetails.normalPrice)}</s> <b>${rupiah(price)}</b> (⭐ Hemat ${rupiah(priceDetails.discountAmount)} Reseller)`
    : `<b>${rupiah(price)}</b>`;

  const page = sess.servicePage || 1;
  const confirmText = `<blockquote>📱 <b>KONFIRMASI ORDER (SERVER 2)</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(fresh.name)}</b>
🌍 Negara: <b>Indonesia</b>
📦 Stok Tersedia: <b>${Number(fresh.stock || 0).toLocaleString("id-ID")} pcs</b>
💰 Harga: ${priceLabel}
🪙 Coin Kamu: <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Coin akan dipotong setelah kamu menekan tombol <b>Beli Sekarang</b>.</blockquote>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🛒 Beli Sekarang", `eu_buy_${fresh.id}_${uid}`)],
    [Markup.button.callback("⬅️ Kembali ke Daftar", `eu_service_pg_${uid}_${page}`)],
  ]);

  if (ctx.callbackQuery?.message?.message_id) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      confirmText,
      { parse_mode: "HTML", reply_markup: keyboard.reply_markup }
    ).catch(() => ctx.replyWithHTML(confirmText, keyboard));
  }
  return ctx.replyWithHTML(confirmText, keyboard);
});

bot.action(/^eu_buy_(\d+)_(\d+)$/, async (ctx) => {
  const serviceId = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  if (buyLocks.has(uid)) {
    return ctx.answerCbQuery("⏳ Order sedang diproses, mohon tunggu sebentar...", { show_alert: true });
  }
  if (wahubSessionLimitReached(uid)) {
    return ctx.answerCbQuery(
      `⚠️ Batas sessions order tercapai (maksimal ${MAX_WAHUB_SESSIONS}).`,
      { show_alert: true }
    );
  }
  buyLocks.add(uid);
  try {
    await ctx.answerCbQuery("⏳ Memproses order Server 2...");

    const fresh = (await engineunicorn.getServices()).find((service) => String(service.id) === String(serviceId));
    if (!fresh || fresh.stock <= 0) {
      return ctx.answerCbQuery("❌ Stok layanan ini baru saja habis.", { show_alert: true });
    }

    return await createEngineUnicornOrder(ctx, uid, fresh);
  } finally {
    setTimeout(() => buyLocks.delete(uid), 1500);
  }
});

// ── ⭐ FITUR RESELLER (HARGA KHUSUS & TARGET BULANAN) ──────────
bot.hears(["⭐ Reseller", "Reseller", "reseller"], showResellerMenu);
bot.command("reseller", showResellerMenu);
bot.action(/^reseller_info_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  return showResellerMenu(ctx);
});

function getIndonesianMonthName(monthStr) {
  const months = {
    "01": "Januari", "02": "Februari", "03": "Maret", "04": "April",
    "05": "Mei", "06": "Juni", "07": "Juli", "08": "Agustus",
    "09": "September", "10": "Oktober", "11": "November", "12": "Desember",
  };
  const parts = String(monthStr || "").split("-");
  const m = parts[1] || "";
  const y = parts[0] || "";
  return `${months[m] || m} ${y}`.trim();
}

async function showResellerMenu(ctx) {
  const uid = ctx.from.id;
  const en = isEN(uid);
  const user = db.getUser(uid);
  const settings = db.getResellerSettings();
  const isReseller = db.isReseller(uid);
  const monthlyTrx = Number(user?.monthlyTrx || 0);
  const threshold = Number(settings.threshold || 100);
  const currentMonthStr = db.getCurrentMonth();
  const monthLabel = getIndonesianMonthName(currentMonthStr);

  const percent = Math.min(100, Math.floor((monthlyTrx / threshold) * 100));
  const filledBlocks = Math.min(10, Math.floor(percent / 10));
  const progressBar = "█".repeat(filledBlocks) + "░".repeat(10 - filledBlocks);
  const sisaTrx = Math.max(0, threshold - monthlyTrx);

  const diskonText = settings.discountMode === "percent"
    ? `${settings.discountValue}%`
    : rupiah(settings.discountValue);

  let text = "";
  if (en) {
    text = `<blockquote>⭐ <b>RESELLER PROGRAM</b>
━━━━━━━━━━━━━━━━
👤 Account: <b>${ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name}</b>
📅 Period : <b>${monthLabel}</b>
🏷️ Status : <b>${isReseller ? "⭐ RESELLER ACTIVE" : "👤 REGULAR MEMBER"}</b>
${user?.isManualReseller ? "👑 Status: <b>Permanent VIP Reseller</b>\n" : ""}
📊 Monthly Progress:
├ 🔄 Success TRX: <b>${monthlyTrx} / ${threshold} TRX</b>
└ 📈 Progress   : <code>[${progressBar}]</code> <b>${percent}%</b>
━━━━━━━━━━━━━━━━
${isReseller
  ? `🎉 <b>Congratulations! Reseller role is active.</b>\nYou get an automatic discount of <b>${diskonText}</b> per number with cost-price protection!`
  : `⏳ <b>${sisaTrx} more successful transactions</b> to unlock the reseller special price for this month!`
}

🎁 <b>Reseller Benefits:</b>
• Cheaper price on ALL services & countries
• Automatic discount applied at checkout
• Cost protection ensures top service availability

💡 <i>Note: Monthly transactions reset on the 1st of each month at 00:00 WIB.</i></blockquote>`;
  } else {
    text = `<blockquote>⭐ <b>PROGRAM RESELLER NOKOS</b>
━━━━━━━━━━━━━━━━
👤 Akun   : <b>${ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name}</b>
📅 Periode: <b>${monthLabel}</b>
🏷️ Status : <b>${isReseller ? "⭐ RESELLER AKTIF" : "👤 MEMBER REGULAR"}</b>
${user?.isManualReseller ? "👑 Status: <b>VIP Reseller Tetap (Permanent)</b>\n" : ""}
📊 Progress Transaksi Bulan Ini:
├ 🔄 Transaksi Sukses: <b>${monthlyTrx} / ${threshold} TRX</b>
└ 📈 Progress Bar    : <code>[${progressBar}]</code> <b>${percent}%</b>
━━━━━━━━━━━━━━━━
${isReseller
  ? `🎉 <b>Selamat! Role Reseller kamu aktif.</b>\nNikmati potongan harga otomatis <b>${diskonText}</b> per nomor di semua server dan layanan!`
  : `⏳ <b>${sisaTrx} transaksi sukses lagi</b> untuk membuka role RESELLER dan menikmati harga lebih murah bulan ini!`
}

🎁 <b>Keuntungan Reseller:</b>
• Harga lebih murah di SEMUA server & negara
• Diskon otomatis teraplikasi saat membeli nomor
• Bebas biaya pendaftaran (cukup capai 100 TRX sukses)

💡 <i>Catatan: Hitungan transaksi kualifikasi reseller di-reset otomatis setiap tanggal 1 awal bulan jam 00:00 WIB.</i></blockquote>`;
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🛒 Beli Nokos", `back_to_server_choice_${uid}`)],
    [Markup.button.callback("⬅️ Menu Utama", `back_main_${uid}`)],
  ]);

  if (ctx.callbackQuery?.message?.message_id) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      text,
      { parse_mode: "HTML", reply_markup: keyboard.reply_markup }
    ).catch(() => ctx.replyWithHTML(text, keyboard));
  }
  return ctx.replyWithHTML(text, keyboard);
}

async function checkResellerPromotion(botInstance, uid) {
  try {
    const promo = db.checkAndPromoteReseller(uid);
    if (promo.newlyUnlocked) {
      const settings = db.getResellerSettings();
      const diskonText = settings.discountMode === "percent"
        ? `${settings.discountValue}%`
        : rupiah(settings.discountValue);
      const pesan = `<blockquote>🎉 <b>SELAMAT! KAMU RESELLER SEKARANG!</b> 🎉
━━━━━━━━━━━━━━━━
Luar biasa! Kamu telah menembus <b>${settings.threshold} transaksi sukses</b> bulan ini.

Role kamu otomatis di-upgrade menjadi ⭐ <b>RESELLER</b>!
✨ <b>Benefit Spesial:</b>
• Potongan harga <b>${diskonText}</b> di semua layanan & provider
• Diskon otomatis teraplikasi saat order
• Berlaku sepanjang periode bulan ini

Terima kasih atas loyalitas kamu! Belanja makin hemat & untung! 🚀</blockquote>`;
      await botInstance.telegram.sendMessage(uid, pesan, { parse_mode: "HTML" }).catch(() => {});
    }
  } catch (err) {
    console.error("⚠️ [Reseller] Gagal cek promosi reseller:", err.message);
  }
}

bot.action(/^back_main_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  await showMainMenu(ctx, uid);
});

bot.action(/^server_(otpcepat|herosms)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const server = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk sesimu.", { show_alert: true });
  }
  if (!db.getProviderStatus(server)) {
    return ctx.answerCbQuery("⚠️ Provider sedang ditutup owner.", { show_alert: true });
  }
  await ctx.deleteMessage().catch(() => {});
  if (server === "otpcepat") return cmdBeliOtpcepat(ctx);
   return cmdBeliHeroSms(ctx);
});


async function cmdBeliOtpcepat(ctx) {
  if (!db.getProviderStatus("otpcepat")) return ctx.reply("⚠️ Provider server 1 sedang ditutup.");
   const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat negara server 1...</i></blockquote>");
  const countries = await otpcepat.getCountries();

  if (!countries.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
       `<blockquote>❌ <b>Negara server 1 tidak tersedia.</b>
 ${escapeHTML(otpcepat.getLastError() || "Layanan server 1 belum merespons.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  sessions[ctx.from.id] = {
    step: "oc_pilih_country",
    server: "otpcepat",
    otpcepatCountries: countries,
    countryPage: 1,
  };
  await showOtpcepatCountries(ctx, ctx.from.id, loadMsg.message_id);
}

async function showOtpcepatCountries(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const countries = sess?.otpcepatCountries || [];
  const totalPage = Math.max(1, Math.ceil(countries.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.countryPage || 1, 1), totalPage);
  sess.countryPage = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const pageItems = countries.slice(start, start + LIST_PAGE_SIZE);
  const buttons = twoColumnButtons(pageItems, (country) =>
    Markup.button.callback(
      `🌍 ${shortButtonText(country.name, 19)}`,
      `neg_${country.id}_${uid}`
    )
  );
  addPageButtons(
    buttons,
    page,
    totalPage,
    `oc_country_pg_${uid}_${page - 1}`,
    `oc_country_pg_${uid}_${page + 1}`,
    `oc_back_server_${uid}`
  );

  const teks = `<blockquote>🌍 <b>SERVER 1 — OTP CEPAT</b>
━━━━━━━━━━━━━━━━
Pilih negara:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options);
  return ctx.editMessageText(teks, options);
}

bot.action(/^oc_country_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "otpcepat") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.countryPage = parseInt(ctx.match[2]);
  await showOtpcepatCountries(ctx, uid);
});

bot.action(/^oc_back_server_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  await showServerChoice(ctx);
});

bot.action(/^back_server_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  await showServerChoice(ctx);
});

// ── Server 1⃣ SMS — Layanan → Negara → Operator ─────────
async function cmdBeliFastbit(ctx) {
  if (!db.getProviderStatus("fastbit")) return ctx.reply("⚠️ Server 1 (SMS) sedang ditutup.");
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat layanan Server 1 (SMS)...</i></blockquote>");
  const services = await fastbit.getServices();

  if (!services.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ <b>Layanan Server 1 (SMS) tidak tersedia.</b>\n${escapeHTML(fastbit.getLastError() || "Daftar layanan sedang tidak tersedia.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  const uid = ctx.from.id;
  sessions[uid] = {
    step: "fb_pilih_service",
    server: "fastbit",
    smsServer: 1,
    serverLabel: "Server 1⃣ (SMS)",
    fastbitServices: services,
    servicePage: 1,
  };
  await showFastbitServices(ctx, uid, loadMsg.message_id);
}

async function showFastbitServices(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const services = sess?.filteredServices || sess?.fastbitServices || [];
  const totalPage = Math.max(1, Math.ceil(services.length / 30));
  const page = Math.min(Math.max(sess.servicePage || 1, 1), totalPage);
  sess.servicePage = page;
  const start = (page - 1) * 30;
  const pageItems = services.slice(start, start + 30);
  const buttons = threeColumnButtons(pageItems, (service) =>
    Markup.button.callback(
      shortButtonText(service.name, 14),
      `fb_svc_${service.id}_${uid}`
    )
  );
  addPageButtons(
    buttons,
    page,
    totalPage,
    `fb_service_pg_${uid}_${page - 1}`,
    `fb_service_pg_${uid}_${page + 1}`,
    `back_fb_server_${uid}`
  );

  if (sess?.filteredServices) {
    buttons.push([
      Markup.button.callback("🔍 Cari Lagi", `search_sms_svc_fastbit_${uid}`),
      Markup.button.callback("❌ Reset Pencarian", `reset_sms_svc_fastbit_${uid}`),
    ]);
  } else {
    buttons.push([
      Markup.button.callback("🔍 Cari Layanan", `search_sms_svc_fastbit_${uid}`),
    ]);
  }

  const teks = sess?.filteredServices
    ? `<blockquote>🔧 <b>SERVER 1⃣ (SMS) — HASIL PENCARIAN</b>
🔍 Kata kunci: <b>${escapeHTML(sess.searchQuery || "")}</b> (${services.length} layanan)
━━━━━━━━━━━━━━━━
Hal ${page}/${totalPage}</blockquote>`
    : `<blockquote>🔧 <b>SERVER 1⃣ (SMS) — PILIH LAYANAN</b>
━━━━━━━━━━━━━━━━
Pilih aplikasi untuk melanjutkan:
Hal ${page}/${totalPage}</blockquote>`;

  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^fb_service_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "fastbit" || sess.step !== "fb_pilih_service") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.servicePage = parseInt(ctx.match[2]);
  await showFastbitServices(ctx, uid);
});

bot.action(/^back_fb_server_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  await showSmsServerChoice(ctx, uid);
});

bot.action(/^fb_svc_([A-Za-z0-9_-]+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const serviceId = String(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const list = sess?.filteredServices || sess?.fastbitServices || [];
  const service = list.find((item) => String(item.id) === serviceId);
  if (!sess || sess.server !== "fastbit" || !service) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat negara dan penawaran Server 1...</i></blockquote>");
  const countries = await fastbit.getCountriesForService(serviceId);
  if (!countries.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ <b>Stok negara tidak tersedia.</b>\n${escapeHTML(fastbit.getLastError() || "Belum ada negara yang memiliki stok untuk layanan ini.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  sess.serviceId = serviceId;
  sess.serviceName = service.name;
  sess.fbCountries = countries;
  sess.countryPage = 1;
  sess.step = "fb_pilih_country";
  await showFastbitCountries(ctx, uid, loadMsg.message_id);
});

async function showFastbitCountries(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const countries = sess?.fbCountries || [];
  const totalPage = Math.max(1, Math.ceil(countries.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.countryPage || 1, 1), totalPage);
  sess.countryPage = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const pageItems = countries.slice(start, start + LIST_PAGE_SIZE);
  const buttons = twoColumnButtons(pageItems, (country) => {
    const baseIdr = country.price;
    const retailPrice = db.calculatePrice("fastbit", baseIdr, sess.serviceId, uid);
    const stock = country.stock ? ` (${formatStock(country.stock)})` : "";
    return Markup.button.callback(
      `🌍 ${shortButtonText(country.name, 12)} · ${rupiah(retailPrice)}${stock}`,
      `fb_country_${country.iso}_${uid}`
    );
  });
  addPageButtons(
    buttons,
    page,
    totalPage,
    `fb_country_pg_${uid}_${page - 1}`,
    `fb_country_pg_${uid}_${page + 1}`,
    `back_fb_service_${uid}`
  );

  const teks = `<blockquote>🌍 <b>SERVER 1⃣ (SMS) — PILIH NEGARA</b>
🔧 Layanan: <b>${escapeHTML(sess.serviceName || "")}</b>
━━━━━━━━━━━━━━━━
Pilih negara yang tersedia:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^fb_country_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "fastbit" || sess.step !== "fb_pilih_country") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.countryPage = parseInt(ctx.match[2]);
  await showFastbitCountries(ctx, uid);
});

bot.action(/^back_fb_service_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "fastbit") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "fb_pilih_service";
  await showFastbitServices(ctx, uid);
});

bot.action(/^fb_country_([A-Za-z0-9_-]+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  const countryIso = String(ctx.match[1]).toUpperCase();
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const country = sess?.fbCountries?.find((item) => String(item.iso).toUpperCase() === countryIso || String(item.id).toUpperCase() === countryIso);
  if (!sess || sess.server !== "fastbit" || sess.step !== "fb_pilih_country" || !country) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  sess.countryId = country.iso;
  sess.countryName = country.name;
  sess.countryOffers = country.offers || [];

  if (country.offers && country.offers.length > 1) {
    sess.operatorPage = 1;
    sess.step = "fb_pilih_operator";
    await showFastbitOperators(ctx, uid);
  } else if (country.offers && country.offers.length === 1) {
    const offer = country.offers[0];
    sess.otpServiceId = offer.id;
    sess.operatorName = offer.operator || "Semua Operator";
    sess.hargaDasar = offer.price;
    sess.stock = offer.stock;
    await showFastbitConfirmation(ctx, uid);
  } else {
    sess.otpServiceId = null;
    sess.operatorName = "Semua Operator";
    sess.hargaDasar = country.price;
    sess.stock = country.stock;
    await showFastbitConfirmation(ctx, uid);
  }
});

async function showFastbitOperators(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const operators = sess?.countryOffers || [];
  const totalPage = Math.max(1, Math.ceil(operators.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.operatorPage || 1, 1), totalPage);
  sess.operatorPage = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const pageItems = operators.slice(start, start + LIST_PAGE_SIZE);
  const buttons = twoColumnButtons(pageItems, (offer, index) => {
    const retailPrice = db.calculatePrice("fastbit", offer.price, sess.serviceId, uid);
    const stock = offer.stock ? ` (${formatStock(offer.stock)})` : "";
    return Markup.button.callback(
      `📡 ${shortButtonText(offer.operator, 10)} · ${rupiah(retailPrice)}${stock}`,
      `fb_op_${start + index}_${uid}`
    );
  });
  addPageButtons(
    buttons,
    page,
    totalPage,
    `fb_operator_pg_${uid}_${page - 1}`,
    `fb_operator_pg_${uid}_${page + 1}`,
    `back_fb_country_${uid}`
  );

  const teks = `<blockquote>📡 <b>SERVER 1⃣ (SMS) — PILIH OPERATOR</b>
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
━━━━━━━━━━━━━━━━
Pilih operator:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^fb_operator_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "fastbit" || sess.step !== "fb_pilih_operator") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.operatorPage = page;
  await showFastbitOperators(ctx, uid);
});

bot.action(/^back_fb_country_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "fastbit") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "fb_pilih_country";
  await showFastbitCountries(ctx, uid);
});

bot.action(/^fb_op_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const operatorIndex = parseInt(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const offer = sess?.countryOffers?.[operatorIndex];
  if (!sess || sess.server !== "fastbit" || sess.step !== "fb_pilih_operator" || !offer) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  sess.otpServiceId = offer.id;
  sess.operatorName = offer.operator;
  sess.hargaDasar = offer.price;
  sess.stock = offer.stock;
  await showFastbitConfirmation(ctx, uid);
});

async function showFastbitConfirmation(ctx, uid) {
  const sess = sessions[uid];
  if (!sess) return;
  const pDetails = db.getResellerPriceDetails(
    "fastbit",
    sess.hargaDasar,
    sess.serviceId,
    uid
  );
  const hargaUser = pDetails.finalPrice;
  const priceDisplay = pDetails.isReseller && pDetails.discountAmount > 0
    ? `<s>${rupiah(pDetails.normalPrice)}</s> <b>${rupiah(hargaUser)}</b> (⭐ Hemat ${rupiah(pDetails.discountAmount)})`
    : `<b>${rupiah(hargaUser)}</b>`;
  const coin = db.getCoin(uid);
  sess.hargaUser = hargaUser;
  sess.step = "fb_konfirmasi";

  if (coin < hargaUser) {
    const kurang = hargaUser - coin;
    const msg = await ctx.replyWithHTML(
`<blockquote>❌ <b>COIN TIDAK CUKUP</b>
━━━━━━━━━━━━━━━━
💰 Harga: <b>${rupiah(hargaUser)}</b>
🪙 Coin mu: <b>${rupiah(coin)}</b>
⚠️ Kurang: <b>${rupiah(kurang)}</b>
━━━━━━━━━━━━━━━━
Deposit coin dulu:</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000", `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000", `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000", `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000", `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 2 * 60 * 1000);
    return;
  }

  const msg = await ctx.replyWithHTML(
`<blockquote>📱 <b>KONFIRMASI ORDER — SERVER 1 (SMS)</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
⚡ Metode: <b>📩 SMS Biasa</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
📡 Operator: <b>${escapeHTML(sess.operatorName || "Semua Operator")}</b>
💰 Harga: ${priceDisplay}
🪙 Coin mu: <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Coin akan langsung dipotong setelah konfirmasi.</blockquote>`,
    Markup.inlineKeyboard([
       [Markup.button.callback("🛒 Beli Sekarang", `fb_buy_${uid}`)],
       [Markup.button.callback("❌ Batalkan", `fb_cancel_${uid}`)],
    ])
  );
  setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 5 * 60 * 1000);
}

bot.action(/^fb_cancel_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  delete sessions[uid];
});

async function cancelFastbitOrder(orderUuid) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await fastbit.cancelOrder(orderUuid);
    if (result) return true;
    if (attempt < 3) await sleep(1000);
  }
  return null;
}

function refundFastbitOrder(uid, sess) {
  const trx = db.getTrxById(sess.trxId);
  if (trx && !trx.refunded) {
    db.markRefunded(sess.trxId);
    db.addCoin(uid, sess.hargaUser);
  }
}

function pollFastbit(uid, orderUuid, phone, sess) {
  let found = false;
  const expiry = Date.now() + OTP_WAIT_MS;

  const iv = setInterval(async () => {
    if (found) return clearInterval(iv);
    if (sessions[uid] !== sess || sess.step !== "tunggu_otp") {
      found = true;
      return clearInterval(iv);
    }

    if (Date.now() > expiry) {
      clearInterval(iv);
      if (found) return;
      found = true;
      sess.cancelProcessing = true;
      await cancelFastbitOrder(orderUuid);
      refundFastbitOrder(uid, sess);
      await bot.telegram.sendMessage(
        uid,
        `<blockquote>⚠️ <b>OTP tidak masuk dalam 20 menit.</b>
Order otomatis dibatalkan.
Coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      delete sessions[uid];
      return;
    }

    try {
      const order = await fastbit.getOrder(orderUuid);
      if (!order) return;

      const otpCode = order.otp_code;
      if (otpCode) {
        found = true;
        clearInterval(iv);
        fastbit.finishOrder(orderUuid).catch(() => {});

        await bot.telegram.sendMessage(
          uid,
          `<blockquote>🔑 <b>OTP MASUK!</b>
━━━━━━━━━━━━━━━━
📱 Nomor: <code>${phone}</code>
⚡ Metode: <b>📩 SMS Biasa</b>
🔑 Kode: <code>${otpCode}</code>
━━━━━━━━━━━━━━━━</blockquote>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [copyOtpButton(otpCode)],
                [{ text: "✅ Pesanan Berhasil", callback_data: `order_done_${uid}_${sess.trxId || orderUuid}` }],
                ...(sess.trxId ? [[{ text: "🛒 Order Lagi", callback_data: `order_again_${uid}_${sess.trxId}` }]] : []),
              ],
            },
          }
        );

        sendChannelRealtimeOtpNotification({
          serviceName: sess.serviceName,
          phone,
          otp: otpCode,
          trxId: sess.trxId || orderUuid,
        }).catch(() => {});

        const userObj = db.getUser(uid);
        sendChannelOrderReportNotification({
          type: "SMS",
          username: userObj?.username || "",
          userId: uid,
          serviceName: sess.serviceName,
          phone,
          harga: sess.hargaUser,
          modal: sess.hargaDasar,
          otp: otpCode,
          serverName: "Server 1 (SMS)",
        }).catch(() => {});

        delete sessions[uid];
        checkResellerPromotion(bot, uid).catch(() => {});
        return;
      }

      const status = String(order.status || "").toLowerCase();
      if (["canceled", "cancelled", "cancel", "failed", "expired"].includes(status)) {
        clearInterval(iv);
        found = true;
        refundFastbitOrder(uid, sess);
        await bot.telegram.sendMessage(
          uid,
          `<blockquote>⚠️ Order ${escapeHTML(order.status)}.
Coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        delete sessions[uid];
      }
    } catch (error) {
      console.error("FastBit poll error:", error.message);
    }
  }, 8_000);
}

async function showHeroServices(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const isServer2 = sess?.smsServer === 2 || sess?.verificationType === "flashcall";
  const serverLabel = isServer2 ? "SERVER 2⃣ (FLASHCALL + SMS)" : "SERVER 1⃣ (SMS)";
  const searchProviderKey = isServer2 ? "rumahotp" : "herosms";
  const services = sess?.filteredServices || sess?.heroServices || [];
  const totalPage = Math.max(1, Math.ceil(services.length / 30));
  const page = Math.min(Math.max(sess.servicePage || 1, 1), totalPage);
  sess.servicePage = page;
  const start = (page - 1) * 30;
  const pageItems = services.slice(start, start + 30);
  const buttons = threeColumnButtons(pageItems, (service) =>
    Markup.button.callback(
      shortButtonText(service.name, 14),
      `hs_svc_${service.id}_${uid}`
    )
  );
  addPageButtons(
    buttons,
    page,
    totalPage,
    `hs_service_pg_${uid}_${page - 1}`,
    `hs_service_pg_${uid}_${page + 1}`,
    `back_hs_server_${uid}`
  );

  if (sess?.filteredServices) {
    buttons.push([
      Markup.button.callback("🔍 Cari Lagi", `search_sms_svc_${searchProviderKey}_${uid}`),
      Markup.button.callback("❌ Reset Pencarian", `reset_sms_svc_${searchProviderKey}_${uid}`),
    ]);
  } else {
    buttons.push([
      Markup.button.callback("🔍 Cari Layanan", `search_sms_svc_${searchProviderKey}_${uid}`),
    ]);
  }

  const teks = sess?.filteredServices
    ? `<blockquote>🔧 <b>${serverLabel} — HASIL PENCARIAN</b>
🔍 Kata kunci: <b>${escapeHTML(sess.searchQuery || "")}</b> (${services.length} layanan)
━━━━━━━━━━━━━━━━
Hal ${page}/${totalPage}</blockquote>`
    : `<blockquote>🔧 <b>${serverLabel} — PILIH LAYANAN</b>
━━━━━━━━━━━━━━━━
Pilih aplikasi untuk melanjutkan:
Hal ${page}/${totalPage}</blockquote>`;

  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^hs_service_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "herosms" || sess.step !== "hs_pilih_service") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.servicePage = parseInt(ctx.match[2]);
  await showHeroServices(ctx, uid);
});

bot.action(/^back_hs_server_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  await showSmsServerChoice(ctx, uid);
});

bot.action(/^hs_svc_([A-Za-z0-9_-]+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const serviceId = String(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const list = sess?.filteredServices || sess?.heroServices || [];
  const service = list.find((item) => String(item.id) === serviceId);
  if (!sess || sess.server !== "herosms" || !service) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat negara dengan stok...</i></blockquote>");
  const countries = await herosms.getCountriesForService(serviceId);
  if (!countries.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ <b>Stok negara tidak tersedia.</b>\n${escapeHTML(herosms.getLastError() || "Belum ada negara yang memiliki stok untuk layanan ini.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  sess.serviceId = serviceId;
  sess.serviceName = service.name;
  sess.heroCountries = countries;
  sess.countryPage = 1;
  sess.step = "hs_pilih_country";
  await showHeroCountries(ctx, uid, loadMsg.message_id);
});

async function showHeroCountries(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const isServer2 = sess?.smsServer === 2 || sess?.verificationType === "flashcall";
  const serverLabel = isServer2 ? "SERVER 2⃣ (FLASHCALL + SMS)" : "SERVER 1⃣ (SMS)";
  const providerKey = isServer2 ? "rumahotp" : "herosms";
  const countries = sess?.heroCountries || [];
  const totalPage = Math.max(1, Math.ceil(countries.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.countryPage || 1, 1), totalPage);
  sess.countryPage = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const pageItems = countries.slice(start, start + LIST_PAGE_SIZE);
  const buttons = twoColumnButtons(pageItems, (country) => {
    const baseIdr = country.priceIdr;
    const retailPrice = db.calculatePrice(providerKey, baseIdr, sess.serviceId, uid);
    const stock = country.stock ? ` (${formatStock(country.stock)})` : "";
    return Markup.button.callback(
      `🌍 ${shortButtonText(country.name, 12)} · ${rupiah(retailPrice)}${stock}`,
      `hs_country_${country.id}_${uid}`
    );
  });
  addPageButtons(
    buttons,
    page,
    totalPage,
    `hs_country_pg_${uid}_${page - 1}`,
    `hs_country_pg_${uid}_${page + 1}`,
    `back_hs_service_${uid}`
  );

  const teks = `<blockquote>🌍 <b>${serverLabel} — PILIH NEGARA</b>
🔧 Layanan: <b>${escapeHTML(sess.serviceName || "")}</b>
━━━━━━━━━━━━━━━━
Pilih negara yang tersedia:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^hs_country_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "herosms" || sess.step !== "hs_pilih_country") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.countryPage = parseInt(ctx.match[2]);
  await showHeroCountries(ctx, uid);
});

bot.action(/^back_hs_service_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "herosms") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "hs_pilih_service";
  await showHeroServices(ctx, uid);
});

bot.action(/^hs_country_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  const countryId = String(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const country = sess?.heroCountries?.find((item) => String(item.id) === countryId);
  if (!sess || sess.server !== "herosms" || sess.step !== "hs_pilih_country" || !country) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  sess.countryId = countryId;
  sess.countryName = country.name;
  sess.hargaAsli = country.price;
  sess.hargaDasar = country.priceIdr;
  sess.stock = country.stock;

  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat operator...</i></blockquote>");
  const operators = await herosms.getOperators(countryId);
  if (operators && operators.length > 0) {
    sess.heroOperators = [{ id: "any", name: "Semua Operator" }, ...operators];
    sess.operatorPage = 1;
    sess.step = "hs_pilih_operator";
    await showHeroOperators(ctx, uid, loadMsg.message_id);
  } else {
    await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    sess.operatorId = "any";
    sess.operatorName = "Semua Operator";
    await showHeroConfirmation(ctx, uid);
  }
});

async function showHeroOperators(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const isServer2 = sess?.smsServer === 2 || sess?.verificationType === "flashcall";
  const serverLabel = isServer2 ? "SERVER 2⃣ (FLASHCALL + SMS)" : "SERVER 1⃣ (SMS)";
  const operators = sess?.heroOperators || [];
  const totalPage = Math.max(1, Math.ceil(operators.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.operatorPage || 1, 1), totalPage);
  sess.operatorPage = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const pageItems = operators.slice(start, start + LIST_PAGE_SIZE);
  const buttons = twoColumnButtons(pageItems, (operator, index) =>
    Markup.button.callback(
      `📡 ${shortButtonText(operator.name, 18)}`,
      `hs_op_${start + index}_${uid}`
    )
  );
  addPageButtons(
    buttons,
    page,
    totalPage,
    `hs_operator_pg_${uid}_${page - 1}`,
    `hs_operator_pg_${uid}_${page + 1}`,
    `back_hs_country_${uid}`
  );

  const teks = `<blockquote>📡 <b>${serverLabel} — PILIH OPERATOR</b>
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
━━━━━━━━━━━━━━━━
Pilih operator:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^hs_operator_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "herosms" || sess.step !== "hs_pilih_operator") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.operatorPage = page;
  await showHeroOperators(ctx, uid);
});

bot.action(/^back_hs_country_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "herosms") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "hs_pilih_country";
  await showHeroCountries(ctx, uid);
});

bot.action(/^hs_op_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const operatorIndex = parseInt(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const operator = sess?.heroOperators?.[operatorIndex];
  if (!sess || sess.server !== "herosms" || sess.step !== "hs_pilih_operator" || !operator) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  sess.operatorId = operator.id;
  sess.operatorName = operator.name;
  await showHeroConfirmation(ctx, uid);
});

async function showHeroConfirmation(ctx, uid) {
  const sess = sessions[uid];
  if (!sess) return;
  const isServer2 = sess.smsServer === 2 || sess.verificationType === "flashcall";
  const providerKey = isServer2 ? "rumahotp" : "herosms";
  const pDetails = db.getResellerPriceDetails(
    providerKey,
    sess.hargaDasar ?? herosms.toIdrPrice(sess.hargaAsli),
    sess.serviceId,
    uid
  );
  const hargaUser = pDetails.finalPrice;
  const priceDisplay = pDetails.isReseller && pDetails.discountAmount > 0
    ? `<s>${rupiah(pDetails.normalPrice)}</s> <b>${rupiah(hargaUser)}</b> (⭐ Hemat ${rupiah(pDetails.discountAmount)})`
    : `<b>${rupiah(hargaUser)}</b>`;
  const coin = db.getCoin(uid);
  sess.hargaUser = hargaUser;
  sess.step = "hs_konfirmasi";

  if (coin < hargaUser) {
    const kurang = hargaUser - coin;
    const msg = await ctx.replyWithHTML(
`<blockquote>❌ <b>COIN TIDAK CUKUP</b>
━━━━━━━━━━━━━━━━
💰 Harga: <b>${rupiah(hargaUser)}</b>
🪙 Coin mu: <b>${rupiah(coin)}</b>
⚠️ Kurang: <b>${rupiah(kurang)}</b>
━━━━━━━━━━━━━━━━
Deposit coin dulu:</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000", `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000", `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000", `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000", `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 2 * 60 * 1000);
    return;
  }

  const msg = await ctx.replyWithHTML(
`<blockquote>📱 <b>KONFIRMASI ORDER — ${isServer2 ? "FLASHCALL + SMS" : "SMS"}</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
⚡ Metode: <b>${isServer2 ? "FlashCall + SMS (Panggilan / SMS)" : "SMS Biasa"}</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
📡 Operator: <b>${escapeHTML(sess.operatorName || "Semua Operator")}</b>
💰 Harga: ${priceDisplay}
🪙 Coin mu: <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Coin akan langsung dipotong setelah konfirmasi.</blockquote>`,
    Markup.inlineKeyboard([
       [Markup.button.callback("🛒 Beli Sekarang", `hs_buy_${uid}`)],
       [Markup.button.callback("❌ Batalkan", `hs_cancel_${uid}`)],
    ])
  );
  setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 5 * 60 * 1000);
}

// ── Search Handlers for SMS Services (Server 1 & Server 2) ─────
bot.action(/^search_sms_svc_(fastbit|herosms|rumahotp)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const server = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess) return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });

  sess.step = "waiting_sms_service_search";
  sess.searchServer = server;

  await ctx.replyWithHTML(
    `<blockquote>🔍 <b>CARI LAYANAN SMS</b>
━━━━━━━━━━━━━━━━
Ketik nama aplikasi/layanan yang ingin kamu cari:
<i>Contoh: <code>WhatsApp</code>, <code>Telegram</code>, <code>Shopee</code>, <code>Gojek</code>, <code>DANA</code></i></blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🔙 Batalkan", `cancel_sms_search_${server}_${uid}`)],
    ])
  );
});

bot.action(/^reset_sms_svc_(fastbit|herosms|rumahotp)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("Memuat ulang layanan...");
  const server = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess) return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });

  delete sess.filteredServices;
  delete sess.searchQuery;
  sess.servicePage = 1;
  if (server === "fastbit") {
    sess.step = "fb_pilih_service";
    await showFastbitServices(ctx, uid, ctx.callbackQuery?.message?.message_id);
  } else {
    sess.step = "hs_pilih_service";
    await showHeroServices(ctx, uid, ctx.callbackQuery?.message?.message_id);
  }
});

bot.action(/^cancel_sms_search_(fastbit|herosms|rumahotp)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  const server = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess) return;

  if (server === "fastbit") {
    sess.step = "fb_pilih_service";
    await showFastbitServices(ctx, uid);
  } else {
    sess.step = "hs_pilih_service";
    await showHeroServices(ctx, uid);
  }
});

bot.action(/^hs_cancel_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  delete sessions[uid];
});

// ── RumahOTP (Server 2 SMS) ──────────────────────────────────
async function showRumahOtpServices(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const services = sess?.filteredServices || sess?.roServices || [];
  const totalPage = Math.max(1, Math.ceil(services.length / 30));
  const page = Math.min(Math.max(sess.servicePage || 1, 1), totalPage);
  sess.servicePage = page;
  const start = (page - 1) * 30;
  const pageItems = services.slice(start, start + 30);
  const buttons = threeColumnButtons(pageItems, (service, index) =>
    Markup.button.callback(
      shortButtonText(service.name, 14),
      `ro_svc_${start + index}_${uid}`
    )
  );
  addPageButtons(
    buttons,
    page,
    totalPage,
    `ro_service_pg_${uid}_${page - 1}`,
    `ro_service_pg_${uid}_${page + 1}`,
    `back_ro_server_${uid}`
  );

  if (sess?.filteredServices) {
    buttons.push([
      Markup.button.callback("🔍 Cari Lagi", `search_sms_svc_rumahotp_${uid}`),
      Markup.button.callback("❌ Reset Pencarian", `reset_sms_svc_rumahotp_${uid}`),
    ]);
  } else {
    buttons.push([
      Markup.button.callback("🔍 Cari Layanan", `search_sms_svc_rumahotp_${uid}`),
    ]);
  }

  const teks = sess?.filteredServices
    ? `<blockquote>🛒 <b>SERVER 2⃣ — HASIL PENCARIAN</b>
🔍 Kata kunci: <b>${escapeHTML(sess.searchQuery || "")}</b> (${services.length} layanan)
━━━━━━━━━━━━━━━━
Hal ${page}/${totalPage}</blockquote>`
    : `<blockquote>🛒 <b>SERVER 2⃣ — PILIH LAYANAN</b>
━━━━━━━━━━━━━━━━
Pilih layanan SMS yang diinginkan:
Hal ${page}/${totalPage}</blockquote>`;

  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^ro_service_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "rumahotp" || sess.step !== "ro_pilih_service") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.servicePage = parseInt(ctx.match[2]);
  await showRumahOtpServices(ctx, uid);
});

bot.action(/^back_ro_server_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  await showSmsServerChoice(ctx, uid);
});

bot.action(/^ro_svc_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const index = parseInt(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const list = sess?.filteredServices || sess?.roServices || [];
  const service = list[index];
  if (!sess || sess.server !== "rumahotp" || !service) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat negara...</i></blockquote>");
  const countries = await rumahotp.getCountries(service.id);
  if (!countries.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ <b>Negara tidak tersedia.</b>\n${escapeHTML(rumahotp.getLastError() || "Belum ada negara untuk layanan ini.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  sess.step = "ro_pilih_country";
  sess.serviceId = service.id;
  sess.serviceName = service.name;
  sess.roCountries = countries;
  sess.countryPage = 1;
  await showRumahOtpCountries(ctx, uid, loadMsg.message_id);
});

async function showRumahOtpCountries(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const countries = sess?.roCountries || [];
  const totalPage = Math.max(1, Math.ceil(countries.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.countryPage || 1, 1), totalPage);
  sess.countryPage = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const pageItems = countries.slice(start, start + LIST_PAGE_SIZE);
  const buttons = twoColumnButtons(pageItems, (country, index) => {
    const price = db.calculatePrice("rumahotp", country.price, sess.serviceId, uid);
    const stockInfo = country.stock !== undefined && country.stock !== null ? ` (${country.stock})` : "";
    return Markup.button.callback(
      `🌍 ${shortButtonText(country.name, 12)} · ${rupiah(price)}${stockInfo}`,
      `ro_country_${start + index}_${uid}`
    );
  });
  addPageButtons(
    buttons,
    page,
    totalPage,
    `ro_country_pg_${uid}_${page - 1}`,
    `ro_country_pg_${uid}_${page + 1}`,
    `back_ro_service_${uid}`
  );

  const teks = `<blockquote>🌍 <b>SERVER 2⃣ — PILIH NEGARA</b>
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
━━━━━━━━━━━━━━━━
Pilih negara:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^ro_country_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "rumahotp" || sess.step !== "ro_pilih_country") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.countryPage = parseInt(ctx.match[2]);
  await showRumahOtpCountries(ctx, uid);
});

bot.action(/^back_ro_service_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "rumahotp") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "ro_pilih_service";
  await showRumahOtpServices(ctx, uid);
});

bot.action(/^ro_country_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const index = parseInt(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const country = sess?.roCountries?.[index];
  if (!sess || sess.server !== "rumahotp" || sess.step !== "ro_pilih_country" || !country) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  sess.countryId = country.id;
  sess.countryName = country.name;
  sess.numberId = country.numberId || country.id;
  sess.providerId = country.providerId || "0";
  sess.hargaDasar = Number(country.price || 0);

  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memeriksa operator...</i></blockquote>");
  const operators = await rumahotp.getOperators(country.id, country.providerId);

  if (operators && operators.length > 1) {
    sess.roOperators = operators;
    sess.operatorPage = 1;
    sess.step = "ro_pilih_operator";
    await showRumahOtpOperators(ctx, uid, loadMsg.message_id);
  } else {
    await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    sess.operatorId = operators?.[0]?.id || "0";
    sess.operatorName = operators?.[0]?.name || "Otomatis";
    await showRumahOtpConfirmation(ctx, uid);
  }
});

async function showRumahOtpOperators(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const operators = sess?.roOperators || [];
  const totalPage = Math.max(1, Math.ceil(operators.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.operatorPage || 1, 1), totalPage);
  sess.operatorPage = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const pageItems = operators.slice(start, start + LIST_PAGE_SIZE);
  const buttons = twoColumnButtons(pageItems, (operator, index) =>
    Markup.button.callback(
      `📡 ${shortButtonText(operator.name, 18)}`,
      `ro_op_${start + index}_${uid}`
    )
  );
  addPageButtons(
    buttons,
    page,
    totalPage,
    `ro_op_pg_${uid}_${page - 1}`,
    `ro_op_pg_${uid}_${page + 1}`,
    `back_ro_country_${uid}`
  );

  const teks = `<blockquote>📡 <b>SERVER 2⃣ — PILIH OPERATOR</b>
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
━━━━━━━━━━━━━━━━
Pilih operator:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.editMessageText(teks, options).catch(() => ctx.replyWithHTML(teks, options));
}

bot.action(/^ro_op_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "rumahotp" || sess.step !== "ro_pilih_operator") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.operatorPage = parseInt(ctx.match[2]);
  await showRumahOtpOperators(ctx, uid);
});

bot.action(/^back_ro_country_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "rumahotp") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "ro_pilih_country";
  await showRumahOtpCountries(ctx, uid);
});

bot.action(/^ro_op_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const index = parseInt(ctx.match[1]);
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const operator = sess?.roOperators?.[index];
  if (!sess || sess.server !== "rumahotp" || sess.step !== "ro_pilih_operator" || !operator) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  sess.operatorId = operator.id;
  sess.operatorName = operator.name;
  await showRumahOtpConfirmation(ctx, uid);
});

async function showRumahOtpConfirmation(ctx, uid) {
  const sess = sessions[uid];
  if (!sess || sess.server !== "rumahotp") {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  const pDetails = db.getResellerPriceDetails(
    "rumahotp",
    sess.hargaDasar,
    sess.serviceId,
    uid
  );
  const hargaUser = pDetails.finalPrice;
  const priceDisplay = pDetails.isReseller && pDetails.discountAmount > 0
    ? `<s>${rupiah(pDetails.normalPrice)}</s> <b>${rupiah(hargaUser)}</b> (⭐ Hemat ${rupiah(pDetails.discountAmount)})`
    : `<b>${rupiah(hargaUser)}</b>`;
  const coin = db.getCoin(uid);
  sess.hargaUser = hargaUser;
  sess.step = "ro_konfirmasi";

  if (coin < hargaUser) {
    const kurang = hargaUser - coin;
    const msg = await ctx.replyWithHTML(
`<blockquote>❌ <b>COIN TIDAK CUKUP</b>
━━━━━━━━━━━━━━━━
💰 Harga: <b>${rupiah(hargaUser)}</b>
🪙 Coin mu: <b>${rupiah(coin)}</b>
⚠️ Kurang: <b>${rupiah(kurang)}</b>
━━━━━━━━━━━━━━━━
Deposit coin dulu:</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000", `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000", `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000", `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000", `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 2 * 60 * 1000);
    return;
  }

  const msg = await ctx.replyWithHTML(
`<blockquote>📱 <b>KONFIRMASI ORDER</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
📡 Operator: <b>${escapeHTML(sess.operatorName || "Otomatis")}</b>
💰 Harga: ${priceDisplay}
🪙 Coin mu: <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Coin akan langsung dipotong setelah konfirmasi.</blockquote>`,
    Markup.inlineKeyboard([
       [Markup.button.callback("🛒 Beli Sekarang", `ro_buy_${uid}`)],
       [Markup.button.callback("❌ Batalkan", `ro_cancel_${uid}`)],
    ])
  );
  setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 5 * 60 * 1000);
}

bot.action(/^ro_cancel_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  delete sessions[uid];
});

async function showOtpcepatServices(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const services = sess?.otpServices || [];
  const totalPage = Math.max(1, Math.ceil(services.length / 30));
  const page = Math.min(Math.max(sess.servicePage || 1, 1), totalPage);
  sess.servicePage = page;
  const start = (page - 1) * 30;
  const pageItems = services.slice(start, start + 30);
  const buttons = threeColumnButtons(pageItems, (service) =>
    Markup.button.callback(
      shortButtonText(service.name, 14),
      `svc_${service.id}_${uid}`
    )
  );
  addPageButtons(
    buttons,
    page,
    totalPage,
    `sms_service_pg_${uid}_${page - 1}`,
    `sms_service_pg_${uid}_${page + 1}`,
    `back_sms_country_${uid}`
  );

  const teks = `<blockquote>🔧 <b>SERVER 1 — PILIH LAYANAN</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
━━━━━━━━━━━━━━━━
Pilih layanan:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options);
  return ctx.editMessageText(teks, options);
}

bot.action(/^sms_service_pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "otpcepat" || sess.step !== "oc_pilih_service") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.servicePage = parseInt(ctx.match[2]);
  await showOtpcepatServices(ctx, uid);
});

bot.action(/^back_sms_country_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "otpcepat") {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "oc_pilih_country";
  await showOtpcepatCountries(ctx, uid);
});

// ── Callback: Pilih Negara → Services ────────────────────
bot.action(/^neg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const countryId   = parseInt(ctx.match[1]);
  const uid         = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  const selectedCountry = sessions[uid]?.otpcepatCountries?.find(
    (country) => Number(country.id) === countryId
  );
  if (!selectedCountry) return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  const countryName = selectedCountry.name;

  const loadMsg = await ctx.replyWithHTML(
    `<blockquote>🔍 <i>Memuat layanan ${escapeHTML(countryName)}...</i></blockquote>`
  );

  const services = await otpcepat.getServices(countryId);

  if (!services.length) {
    return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
      `❌ Tidak ada layanan tersedia untuk <b>${escapeHTML(countryName)}</b>.`,
      { parse_mode: "HTML" }
    );
  }

  const previousSession = sessions[ctx.from.id];
  sessions[ctx.from.id] = {
    step: "oc_pilih_service",
    server: "otpcepat",
    countryId,
    countryName,
    otpcepatCountries: previousSession?.otpcepatCountries || [],
    otpServices: services,
    servicePage: 1,
  };
  await showOtpcepatServices(ctx, ctx.from.id, loadMsg.message_id);
});

// ── Callback: Pilih Service → Operator ────────────────────
bot.action(/^svc_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const serviceId = String(ctx.match[1]);
  const uid        = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  if (!sess) return ctx.reply("❌ Sesi habis. Ulangi /buynokos");

  const service = sess.otpServices?.find((item) => item.id === serviceId);
  if (sess.server !== "otpcepat" || sess.step !== "oc_pilih_service" || !service) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat operator...</i></blockquote>");
  const operators = await otpcepat.getOperators(sess.countryId);
  if (!operators.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ <b>Operator tidak tersedia.</b>
${escapeHTML(otpcepat.getLastError() || "Operator untuk negara ini sedang tidak tersedia.")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  sess.serviceId = service.id;
  sess.serviceName = service.name;
  sess.hargaAsli = service.price;
  sess.otpOperators = operators;
  sess.step = "oc_pilih_operator";
  sess.page = 1;
  await showProducts(ctx, uid, loadMsg.message_id);
});

// ── Tampilkan operator dengan pagination ──────────────────
async function showProducts(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const operators = sess?.otpOperators || [];
  const totalPage = Math.max(1, Math.ceil(operators.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(sess.page || 1, 1), totalPage);
  sess.page = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const allBtns = operators.slice(start, start + LIST_PAGE_SIZE).map((operator, index) => {
    return Markup.button.callback(
      `📡 ${shortButtonText(operator.name, 18)}`,
      `prod_${start + index}_${uid}`
    );
  });
  const buttons = [];
  for (let i = 0; i < allBtns.length; i += 2) {
    const row = [allBtns[i]];
    if (allBtns[i + 1]) row.push(allBtns[i + 1]);
    buttons.push(row);
  }

  addPageButtons(
    buttons,
    page,
    totalPage,
    `pg_${uid}_${page - 1}`,
    `pg_${uid}_${page + 1}`,
    `back_sms_service_${uid}`
  );

  const pDetails = db.getResellerPriceDetails("otpcepat", sess.hargaAsli, sess.serviceId, uid);
  const teks =
`<blockquote>📡 <b>PILIH OPERATOR</b>
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
🌍 ${escapeHTML(sess.countryName)} | Hal ${page}/${totalPage}
━━━━━━━━━━━━━━━━
Harga: ${pDetails.isReseller && pDetails.discountAmount > 0 ? `<s>${rupiah(pDetails.normalPrice)}</s> <b>${rupiah(pDetails.finalPrice)}</b> (⭐ Hemat ${rupiah(pDetails.discountAmount)})` : `<b>${rupiah(pDetails.finalPrice)}</b>`}
Pilih operator:</blockquote>`;

  if (editMsgId) {
    await ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
    );
  } else {
    await ctx.editMessageText(teks,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
    );
  }
}

// ── NEXT/PREV ─────────────────────────────────────────────
bot.action(/^pg_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid  = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "otpcepat" || sess.step !== "oc_pilih_operator") {
    return ctx.reply("❌ Sesi habis.");
  }
  sess.page = page;
  await showProducts(ctx, uid);
});

bot.action(/^back_sms_service_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "otpcepat" || !sess.otpServices) {
    return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  }
  sess.step = "oc_pilih_service";
  await showOtpcepatServices(ctx, uid);
});

// ── Callback: Pilih Operator → Cek Coin ──────────────────
bot.action(/^prod_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const operatorIndex = parseInt(ctx.match[1]);
  const uid       = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return;

  const sess = sessions[uid];
  const operator = sess?.otpOperators?.[operatorIndex];
  if (!sess || sess.server !== "otpcepat" || sess.step !== "oc_pilih_operator" || !operator) {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }

  const pDetails = db.getResellerPriceDetails("otpcepat", sess.hargaAsli, sess.serviceId, uid);
  const hargaUser = pDetails.finalPrice;
  const priceDisplay = pDetails.isReseller && pDetails.discountAmount > 0
    ? `<s>${rupiah(pDetails.normalPrice)}</s> <b>${rupiah(hargaUser)}</b> (⭐ Hemat ${rupiah(pDetails.discountAmount)})`
    : `<b>${rupiah(hargaUser)}</b>`;
  const coin      = db.getCoin(uid);

  sess.step       = "konfirmasi";
  sess.operatorId = operator.id;
  sess.operatorName = operator.name;
  sess.hargaUser = hargaUser;

  if (coin < hargaUser) {
    const kurang = hargaUser - coin;
    const msg = await ctx.replyWithHTML(
`<blockquote>❌ <b>COIN TIDAK CUKUP</b>
━━━━━━━━━━━━━━━━
💰 Harga   : <b>${rupiah(hargaUser)}</b>
🪙 Coin mu : <b>${rupiah(coin)}</b>
⚠️ Kurang  : <b>${rupiah(kurang)}</b>
━━━━━━━━━━━━━━━━
Deposit coin dulu:</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000",   `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000",  `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000",  `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000",  `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 2 * 60 * 1000);
    return;
  }

  const msg = await ctx.replyWithHTML(
`<blockquote>📱 <b>KONFIRMASI ORDER</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
🌍 Negara  : <b>${escapeHTML(sess.countryName)}</b>
📡 Operator: <b>${escapeHTML(sess.operatorName)}</b>
💰 Harga   : ${priceDisplay}
🪙 Coin mu : <b>${rupiah(coin)}</b>
━━━━━━━━━━━━━━━━
Coin akan langsung dipotong setelah konfirmasi.</blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🛒 Beli Sekarang", `belicoin_${uid}`)],
      [Markup.button.callback("❌ Batalkan",       `batal_${uid}`)],
    ])
  );
  setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 5 * 60 * 1000);
});

// ── Batal ─────────────────────────────────────────────────
bot.action(/^batal_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  delete sessions[parseInt(ctx.match[1])];
});

// ── Beli pakai coin ───────────────────────────────────────
bot.action(/^belicoin_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("⏳ Memproses...");
  await ctx.deleteMessage().catch(() => {});

  const uid  = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.step !== "konfirmasi") return ctx.reply("❌ Sesi habis.");

  if (sess.server === "otpcepat") {
    delete sessions[uid];
    return ctx.replyWithHTML(
      "<blockquote>⚠️ <b>LAYANAN SUDAH DIPERBARUI</b>\n\nServer lama (OTP Cepat) sudah tidak digunakan lagi dan telah diganti dengan <b>Server 1⃣</b> dan <b>Server 2⃣</b>.\nSilakan pesan melalui menu <b>🛒 Beli Nokos</b>.</blockquote>"
    );
  }

  if (sess.processing) {
    return ctx.answerCbQuery("⏳ Sedang diproses, tunggu...", { show_alert: true });
  }
  sess.processing = true;

  const coinCek = db.getCoin(uid);
  if (coinCek < sess.hargaUser) {
    const kurang = sess.hargaUser - coinCek;
    const msg = await ctx.replyWithHTML(
`<blockquote>❌ <b>COIN TIDAK CUKUP</b>
━━━━━━━━━━━━━━━━
💰 Harga   : <b>${rupiah(sess.hargaUser)}</b>
🪙 Coin mu : <b>${rupiah(coinCek)}</b>
⚠️ Kurang  : <b>${rupiah(kurang)}</b>
━━━━━━━━━━━━━━━━
Top up dulu!</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000",   `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000",  `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000",  `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000",  `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60000);
    delete sessions[uid];
    return;
  }

  const result = db.deductCoin(uid, sess.hargaUser);
  if (result === false) {
    const msg2 = await ctx.replyWithHTML(`<blockquote>❌ <b>COIN TIDAK CUKUP</b>\nTop up dulu!</blockquote>`);
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg2.message_id).catch(() => {}), 60000);
    delete sessions[uid];
    return;
  }
  sess.step = "processing";

  const loadMsg = await ctx.replyWithHTML("<blockquote>⏳ <b>Memproses order...</b></blockquote>");

  let order;
  try {
    order = await otpcepat.createOrder(
      sess.operatorId,
      sess.serviceId,
      sess.countryId
    );
  } catch (e) {
    db.addCoin(uid, sess.hargaUser);
    console.error("OTP Cepat createOrder error:", e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
      `<blockquote>❌ Gagal order. Coin dikembalikan.\n💬 Hubungi: ${config.urladmin}</blockquote>`,
      { parse_mode: "HTML" }
    );
    delete sessions[uid];
    return;
  }

  // Accept the provider response exactly as it may arrive:
  // { status: true, data: { order_id, number, ... } }
  // and also tolerate an extra data envelope from an older adapter.
  const orderData =
    normalizeOtpcepatOrder(order) ||
    normalizeOtpcepatOrder(otpcepat.getLastCreateOrderResponse?.());

  // Only this validation means the provider did not create an order.
  // Everything after it is notification/persistence work and must not refund
  // an order that is already pending on OTP Cepat.
  if (!orderData?.order_id || !orderData.number) {
    const reason = "Response order OTP Cepat tidak berisi order_id dan number.";
    const outcome = otpcepat.getLastCreateOrderOutcome?.() || "unknown";
    const isProviderReject = outcome === "rejected";
    if (isProviderReject) db.addCoin(uid, sess.hargaUser);
    console.error("OTP Cepat createOrder rejected:", reason);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      isProviderReject
        ? `<blockquote>❌ Gagal order. Coin dikembalikan.\n💬 Hubungi: ${config.urladmin}</blockquote>`
        : `<blockquote>⚠️ Provider belum memberi kepastian order.\nCoin tidak dipotong ulang demi keamanan.\n💬 Hubungi: ${config.urladmin}</blockquote>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    delete sessions[uid];
    return;
  }

  const orderId = String(orderData.order_id);
  const phone = String(orderData.number);
  const expiry = "20 menit";
  let trxId = null;

  try {
    trxId = db.addTransaction({
      userId:      uid,
      username:    ctx.from.username || ctx.from.first_name,
      orderId,
      phone,
      productName: sess.serviceName,
      negara:      sess.countryName,
      harga:       sess.hargaUser,
      provider:    "otpcepat",
      serviceId:   sess.serviceId,
      countryId:   sess.countryId,
      operatorId:  sess.operatorId,
      providerPrice: sess.hargaAsli,
    });
  } catch (error) {
    console.error("OTP Cepat transaction save error:", error.message);
  }

  sess.orderId = orderId;
  sess.phone   = phone;
  sess.step    = "tunggu_otp";
  sess.cancelAt  = Date.now() + 3 * 60 * 1000;
  sess.orderMsgId = loadMsg.message_id;
  sess.trxId      = trxId;

  const successText =
`<blockquote>✅ <b>ORDER BERHASIL!</b>
━━━━━━━━━━━━━━━━
🌍 Negara  : <b>${escapeHTML(sess.countryName)}</b>
📱 <b>Nomor  : <code>${phone}</code></b>
💰 Harga   : <b>${rupiah(sess.hargaUser)}</b>
🪙 Sisa coin: <b>${rupiah(result)}</b>
🧾 TRX ID  : <code>${trxId || "tidak tersedia"}</code>
⏰ Expires : <i>${expiry}</i>
━━━━━━━━━━━━━━━━
⏳ Gunakan nomor ini untuk verifikasi.
OTP akan otomatis dikirim ke sini!

⚠️ Tombol batalkan aktif setelah 3 menit.</blockquote>`;
  sess.orderMsgId = await updateOrderMessage(ctx, loadMsg, successText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🚫 Batalkan Order", `cancel_order_${uid}`)],
    ]).reply_markup
  });

  sess.testimoniData = {
    username: ctx.from.username || ctx.from.first_name,
    phone,
    negara: sess.countryName,
    harga: sess.hargaUser,
    trxId,
  };
  pollOtpcepat(uid, orderId, phone, sess);
});

// ── Beli Server 1 (SMS) pakai coin ────────────────────────
bot.action(/^fb_buy_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("⏳ Memproses...");
  await ctx.deleteMessage().catch(() => {});

  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "fastbit" || sess.step !== "fb_konfirmasi") return ctx.reply("❌ Sesi habis.");

  if (sess.processing) {
    return ctx.answerCbQuery("⏳ Sedang diproses, tunggu...", { show_alert: true });
  }
  sess.processing = true;

  const coinCek = db.getCoin(uid);
  if (coinCek < sess.hargaUser) {
    const kurang = sess.hargaUser - coinCek;
    const msg = await ctx.replyWithHTML(
`<blockquote>❌ <b>COIN TIDAK CUKUP</b>
━━━━━━━━━━━━━━━━
💰 Harga: <b>${rupiah(sess.hargaUser)}</b>
🪙 Coin mu: <b>${rupiah(coinCek)}</b>
⚠️ Kurang: <b>${rupiah(kurang)}</b>
━━━━━━━━━━━━━━━━
Top up dulu!</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000", `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000", `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000", `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000", `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60_000);
    sess.processing = false;
    return;
  }

  const result = db.deductCoin(uid, sess.hargaUser);
  if (result === false) {
    const msg = await ctx.replyWithHTML("<blockquote>❌ <b>COIN TIDAK CUKUP</b>\nTop up dulu!</blockquote>");
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60_000);
    delete sessions[uid];
    return;
  }
  sess.step = "fb_processing";

  const loadMsg = await ctx.replyWithHTML("<blockquote>⏳ <b>Memproses order...</b></blockquote>");

  let order;
  try {
    order = await fastbit.createOrder({
      serviceId: sess.otpServiceId || sess.serviceId,
      countryId: sess.countryId,
    });
  } catch (error) {
    db.addCoin(uid, sess.hargaUser);
    console.error("FastBit createOrder error:", error.message);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ Gagal order stok provider sedang habis. Coin dikembalikan.\n💬 Hubungi: ${config.urladmin}</blockquote>`,
      { parse_mode: "HTML" }
    );
    delete sessions[uid];
    return;
  }

  if (!order?.order_id || !order.phone_number) {
    const reason = fastbit.getLastError() || "Gagal order nomor. Stok sedang tidak tersedia.";
    db.addCoin(uid, sess.hargaUser);
    console.error("FastBit createOrder rejected:", reason);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ Gagal order. Coin dikembalikan.\n💬 ${escapeHTML(reason)}</blockquote>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    delete sessions[uid];
    return;
  }

  const orderId = order.order_id;
  const phone = order.phone_number;
  const expiry = "20 menit";
  let trxId = null;

  try {
    trxId = db.addTransaction({
      userId: uid,
      username: ctx.from.username || ctx.from.first_name,
      orderId,
      phone,
      productName: sess.serviceName,
      negara: sess.countryName,
      harga: sess.hargaUser,
      provider: "fastbit",
      serviceId: sess.serviceId,
      countryId: sess.countryId,
      operatorId: sess.otpServiceId,
      providerPrice: sess.hargaDasar,
    });
  } catch (error) {
    console.error("FastBit transaction save error:", error.message);
  }

  sess.server = "fastbit";
  sess.orderId = orderId;
  sess.orderUuid = orderId;
  sess.phone = phone;
  sess.step = "tunggu_otp";
  sess.cancelAt = Date.now() + 3 * 60 * 1000;
  sess.orderMsgId = loadMsg.message_id;
  sess.trxId = trxId;
  sess.testimoniData = {
    username: ctx.from.username || ctx.from.first_name,
    phone,
    negara: sess.countryName,
    harga: sess.hargaUser,
    trxId,
  };

  const successText =
`<blockquote>✅ <b>ORDER BERHASIL! (SERVER 1 — SMS)</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
⚡ Metode: <b>📩 SMS Biasa</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
📡 Operator: <b>${escapeHTML(sess.operatorName || "Semua Operator")}</b>
📱 <b>Nomor: <code>${phone}</code></b>
💰 Harga: <b>${rupiah(sess.hargaUser)}</b>
🪙 Sisa coin: <b>${rupiah(result)}</b>
🧾 TRX ID: <code>${trxId || "tidak tersedia"}</code>
⏰ Expires: <i>${expiry}</i>
━━━━━━━━━━━━━━━━
⏳ Gunakan nomor ini untuk verifikasi.
OTP akan otomatis dikirim ke sini!

⚠️ Tombol batalkan aktif setelah 3 menit.</blockquote>`;

  sess.orderMsgId = await updateOrderMessage(ctx, loadMsg, successText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [copyPhoneButton(phone)],
      [Markup.button.callback("🚫 Batalkan Order", `cancel_order_${uid}`)],
    ]).reply_markup,
  });
  pollFastbit(uid, orderId, phone, sess);
});

// ── Beli server 2 pakai coin ──────────────────────────────
bot.action(/^hs_buy_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("⏳ Memproses...");
  await ctx.deleteMessage().catch(() => {});

  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.server !== "herosms" || sess.step !== "hs_konfirmasi") return ctx.reply("❌ Sesi habis.");

  if (sess.processing) {
    return ctx.answerCbQuery("⏳ Sedang diproses, tunggu...", { show_alert: true });
  }
  sess.processing = true;

  const coinCek = db.getCoin(uid);
  if (coinCek < sess.hargaUser) {
    const kurang = sess.hargaUser - coinCek;
    const msg = await ctx.replyWithHTML(
`<blockquote>❌ <b>COIN TIDAK CUKUP</b>
━━━━━━━━━━━━━━━━
💰 Harga: <b>${rupiah(sess.hargaUser)}</b>
🪙 Coin mu: <b>${rupiah(coinCek)}</b>
⚠️ Kurang: <b>${rupiah(kurang)}</b>
━━━━━━━━━━━━━━━━
Top up dulu!</blockquote>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💵 Rp5.000", `dep_5000_${uid}`),
         Markup.button.callback("💵 Rp10.000", `dep_10000_${uid}`)],
        [Markup.button.callback("💵 Rp20.000", `dep_20000_${uid}`),
         Markup.button.callback("💵 Rp50.000", `dep_50000_${uid}`)],
        [Markup.button.callback("💵 Rp100.000", `dep_100000_${uid}`)],
      ])
    );
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60_000);
    sess.processing = false;
    return;
  }

  const result = db.deductCoin(uid, sess.hargaUser);
  if (result === false) {
    const msg = await ctx.replyWithHTML("<blockquote>❌ <b>COIN TIDAK CUKUP</b>\nTop up dulu!</blockquote>");
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60_000);
    delete sessions[uid];
    return;
  }
  sess.step = "hs_processing";

  const loadMsg = await ctx.replyWithHTML("<blockquote>⏳ <b>Memproses order...</b></blockquote>");

  const isFlashcall = sess.smsServer === 2 || sess.verificationType === "flashcall";
  const providerKey = isFlashcall ? "rumahotp" : "herosms";

  let order;
  try {
    order = await herosms.createOrder({
      serviceId: sess.serviceId,
      countryId: sess.countryId,
      operatorId: sess.operatorId,
      maxPrice: sess.hargaAsli,
      reference: `HS-${uid}-${Date.now()}`,
      verification: isFlashcall,
      verificationType: isFlashcall ? "flashcall" : "sms",
    });
  } catch (error) {
    db.addCoin(uid, sess.hargaUser);
    console.error("HeroSMS createOrder error:", error.message);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ Gagal order stok provider sedang habis. Coin dikembalikan.\n💬 Hubungi: ${config.urladmin}</blockquote>`,
      { parse_mode: "HTML" }
    );
    delete sessions[uid];
    return;
  }

  if (!order?.order_id || !order.phone_number) {
    const reason = herosms.getLastError() || "Penyedia tidak mengembalikan data order.";
    db.addCoin(uid, sess.hargaUser);
    console.error("HeroSMS createOrder rejected:", reason);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ Gagal order. Coin dikembalikan.\n💬 ${escapeHTML(reason)}</blockquote>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    delete sessions[uid];
    return;
  }

  const orderId = order.order_id;
  const phone = order.phone_number;
  const expiryTimestamp = Number(order.expired_at);
  const expiry = expiryTimestamp > Date.now()
    ? new Date(expiryTimestamp).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    : "20 menit";
  let trxId = null;

  try {
    trxId = db.addTransaction({
      userId: uid,
      username: ctx.from.username || ctx.from.first_name,
      orderId,
      phone,
      productName: sess.serviceName,
      negara: sess.countryName,
      harga: sess.hargaUser,
      provider: providerKey,
      serviceId: sess.serviceId,
      countryId: sess.countryId,
      operatorId: sess.operatorId,
      providerPrice: sess.hargaAsli,
    });
  } catch (error) {
    console.error("HeroSMS transaction save error:", error.message);
  }

  sess.server = "herosms";
  sess.orderId = orderId;
  sess.phone = phone;
  sess.providerExpiredAt = expiryTimestamp > Date.now() ? expiryTimestamp : null;
  sess.step = "tunggu_otp";
  // Pembatalan manual baru dibuka 3 menit setelah order.
  sess.cancelAt = Date.now() + 3 * 60 * 1000;
  sess.orderMsgId = loadMsg.message_id;
  sess.trxId = trxId;
  sess.testimoniData = {
    username: ctx.from.username || ctx.from.first_name,
    phone,
    negara: sess.countryName,
    harga: sess.hargaUser,
    trxId,
  };

  const title = isFlashcall ? "ORDER BERHASIL! (FLASHCALL + SMS)" : "ORDER BERHASIL! (SMS)";
  const methodText = isFlashcall
    ? "⚡ Metode: <b>📞 FlashCall / 📩 SMS</b>\n"
    : "⚡ Metode: <b>📩 SMS Biasa</b>\n";
  const instructText = isFlashcall
    ? "⏳ Gunakan nomor ini untuk verifikasi.\nKode bisa masuk via Panggilan Telepon (FlashCall) atau SMS!"
    : "⏳ Gunakan nomor ini untuk verifikasi.\nOTP akan otomatis dikirim ke sini!";

  const successText =
`<blockquote>✅ <b>${title}</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
${methodText}🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
📡 Operator: <b>${escapeHTML(sess.operatorName)}</b>
📱 <b>Nomor: <code>${phone}</code></b>
💰 Harga: <b>${rupiah(sess.hargaUser)}</b>
🪙 Sisa coin: <b>${rupiah(result)}</b>
🧾 TRX ID: <code>${trxId || "tidak tersedia"}</code>
⏰ Expires: <i>${expiry}</i>
━━━━━━━━━━━━━━━━
${instructText}

⚠️ Tombol batalkan aktif setelah 3 menit.</blockquote>`;
  sess.orderMsgId = await updateOrderMessage(ctx, loadMsg, successText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [copyPhoneButton(phone)],
      [Markup.button.callback("🚫 Batalkan Order", `cancel_order_${uid}`)],
    ]).reply_markup,
  });
  pollHeroSms(uid, orderId, phone, sess);
});

// ── Beli Server 2 (RumahOTP) ──────────────────────────────
bot.action(/^ro_buy_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});

  const sess = sessions[uid];
  if (!sess || sess.server !== "rumahotp" || sess.step !== "ro_konfirmasi") {
    return ctx.reply("❌ Sesi habis. Ulangi /buynokos");
  }
  if (sess.processing) return;
  sess.processing = true;

  const coin = db.getCoin(uid);
  if (coin < sess.hargaUser) {
    const msg = await ctx.replyWithHTML("<blockquote>❌ <b>COIN TIDAK CUKUP</b>\nTop up dulu!</blockquote>");
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60_000);
    delete sessions[uid];
    return;
  }

  const result = db.deductCoin(uid, sess.hargaUser);
  if (result === false) {
    const msg = await ctx.replyWithHTML("<blockquote>❌ <b>COIN TIDAK CUKUP</b>\nTop up dulu!</blockquote>");
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60_000);
    delete sessions[uid];
    return;
  }

  sess.step = "ro_processing";
  const loadMsg = await ctx.replyWithHTML("<blockquote>⏳ <b>Memproses order ke Server 2...</b></blockquote>");

  let order;
  try {
    order = await rumahotp.buyNumber({
      numberId: sess.numberId,
      providerId: sess.providerId,
      operatorId: sess.operatorId,
    });
  } catch (error) {
    db.addCoin(uid, sess.hargaUser);
    console.error("Server 2 (RumahOTP) buyNumber error:", error.message);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ Gagal order stok provider sedang habis. Coin dikembalikan.\n💬 Hubungi: ${config.urladmin}</blockquote>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    delete sessions[uid];
    return;
  }

  if (!order?.order_id || !order.phone) {
    const reason = rumahotp.getLastError() || "Penyedia tidak mengembalikan data order.";
    db.addCoin(uid, sess.hargaUser);
    console.error("Server 2 (RumahOTP) buyNumber rejected:", reason);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadMsg.message_id,
      null,
      `<blockquote>❌ Gagal order. Coin dikembalikan.\n💬 ${escapeHTML(reason)}</blockquote>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    delete sessions[uid];
    return;
  }

  const orderId = order.order_id;
  const phone = order.phone;
  let trxId = null;

  try {
    trxId = db.addTransaction({
      userId: uid,
      username: ctx.from.username || ctx.from.first_name,
      orderId,
      phone,
      productName: sess.serviceName,
      negara: sess.countryName,
      harga: sess.hargaUser,
      provider: "rumahotp",
      serviceId: sess.serviceId,
      countryId: sess.countryId,
      operatorId: sess.operatorId,
      providerPrice: sess.hargaDasar,
    });
  } catch (error) {
    console.error("Server 2 (RumahOTP) transaction save error:", error.message);
  }

  sess.server = "rumahotp";
  sess.orderId = orderId;
  sess.phone = phone;
  sess.step = "tunggu_otp";
  sess.cancelAt = Date.now() + 3 * 60 * 1000;
  sess.orderMsgId = loadMsg.message_id;
  sess.trxId = trxId;

  const successText = `<blockquote>✅ <b>ORDER BERHASIL!</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(sess.serviceName)}</b>
🌍 Negara: <b>${escapeHTML(sess.countryName)}</b>
📡 Operator: <b>${escapeHTML(sess.operatorName || "Otomatis")}</b>
📱 <b>Nomor: <code>${phone}</code></b>
💰 Harga: <b>${rupiah(sess.hargaUser)}</b>
🪙 Sisa coin: <b>${rupiah(db.getCoin(uid))}</b>
🧾 TRX ID: <code>${trxId || "tidak tersedia"}</code>
⏰ Expires: <i>20 menit</i>
━━━━━━━━━━━━━━━━
⏳ Gunakan nomor ini untuk verifikasi.
OTP akan otomatis dikirim ke sini!

⚠️ Tombol batalkan aktif setelah 3 menit.</blockquote>`;

  sess.orderMsgId = await updateOrderMessage(ctx, loadMsg, successText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [copyPhoneButton(phone)],
      [Markup.button.callback("🚫 Batalkan Order", `cancel_order_${uid}`)],
    ]).reply_markup,
  });
  pollRumahOtpSession(uid, orderId, phone, sess);
});

// ── WAHUB OTP, retry, copy, and refund flow ───────────────
bot.action(/^wahub_retry_(\d+)(?:_(.+))?$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  const sessionKey = ctx.match[2] || null;
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  const sess = getWahubSession(uid, sessionKey);
  if (!canRetryWahubSession(sess)) {
    return ctx.answerCbQuery(
      "❌ Minta ulang OTP hanya tersedia pada status waiting atau paid.",
      { show_alert: true }
    );
  }
  if (sess.retryProcessing) {
    return ctx.answerCbQuery("⏳ Permintaan sedang diproses.", { show_alert: true });
  }
  const retryCount = wahubRetryCount(sess);
  if (retryCount >= 3) {
    return ctx.answerCbQuery("❌ Batas minta ulang OTP sudah habis (3x).", { show_alert: true });
  }

  sess.retryProcessing = true;
  wahubSessionDb.set(uid, sess);
  await ctx.answerCbQuery("⏳ Meminta OTP baru...");
  try {
    let order;
    if (sess.provider === "engineunicorn") {
      const res = await engineunicorn.resend(sess.orderId);
      if (!res.ok) {
        return ctx.answerCbQuery(
          `❌ Gagal minta ulang: ${res.error || "Coba lagi."}`,
          { show_alert: true }
        );
      }
      order = { token: sess.token, order_id: sess.orderId, phone: sess.phone };
    } else {
      order = await wahub.retry(sess.token);
      if (!order?.token || !order.phone) {
        return ctx.answerCbQuery(
          `❌ Gagal minta ulang. ${wahub.getLastError() || "Coba lagi."}`,
          { show_alert: true }
        );
      }
    }
    const latest = getWahubSession(uid, sessionKey || sess.sessionKey);
    if (!canRetryWahubSession(latest)) {
      return ctx.answerCbQuery(
        "❌ Minta ulang OTP ditolak karena order tidak lagi berstatus waiting/paid.",
        { show_alert: true }
      );
    }
    const hadOtp = Boolean(latest?.hasReceivedOtp || latest?.otpReceived || latest?.firstOtp || latest?.lastOtp || latest?.paidAt || isWahubPaidSession(latest));
    const originalPaidAt = latest?.paidAt || sess?.paidAt || null;
    const preservedFirstOtp = latest?.firstOtp || sess?.firstOtp || latest?.otp || sess?.otp || null;
    const preservedLastOtp = latest?.lastOtp || latest?.otp || sess?.lastOtp || sess?.otp || null;

    Object.assign(sess, latest);
    sess.retryCount = retryCount + 1;
    sess.token = order.token;
    sess.orderId = order.order_id || sess.orderId;
    sess.phone = order.phone;
    sess.orderMsgId = ctx.callbackQuery?.message?.message_id || sess.orderMsgId;
    sess.step = "tunggu_otp";
    sess.status = "waiting";
    sess.providerStatus = "waiting";
    if (hadOtp) {
      sess.hasReceivedOtp = true;
      sess.otpReceived = true;
      sess.firstOtp = preservedFirstOtp;
      sess.lastOtp = preservedLastOtp;
      sess.paidAt = originalPaidAt || new Date().toISOString();
    } else {
      delete sess.paidAt;
    }
    delete sess.finishedAt;
    delete sess.cancelledAt;
    sess.expiresAt = Date.now() + OTP_WAIT_MS;
    sess.cancelAt = 0;
    const expiryText = new Date(sess.expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

    const retryButtons = [];
    if (hadOtp && sess.lastOtp) {
      retryButtons.push([copyOtpButton(sess.lastOtp)]);
    }
    if (wahubRetryCount(sess) < 3) {
      retryButtons.push([{ text: `🔁 Minta Ulang OTP (${wahubRetryCount(sess)}/3)`, callback_data: `wahub_retry_${uid}_${sess.sessionKey || sess.trxId}` }]);
    }
    if (hadOtp) {
      retryButtons.push([{ text: "✅ Selesai (Pesanan Berhasil)", callback_data: `order_done_${uid}_${sess.sessionKey || sess.trxId}` }]);
    } else {
      retryButtons.push([{ text: "🔄 Ganti Nomor", callback_data: `wahub_change_num_${uid}_${sess.sessionKey || sess.trxId}` }]);
      retryButtons.push([{ text: "🚫 Batalkan Order", callback_data: `wahub_cancel_${uid}_${sess.sessionKey || sess.trxId}` }]);
    }

    const noteText = hadOtp
      ? "\n━━━━━━━━━━━━━━━━\n💡 <i>Catatan: OTP sebelumnya sudah diterima. Order ini tidak dapat dibatalkan atau di-refund.</i>"
      : "";

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      `<blockquote>✅ <b>OTP DIMINTA ULANG</b>
━━━━━━━━━━━━━━━━
📱 Nomor: <code>${escapeHTML(sess.phone)}</code>
🔁 Percobaan: <b>${sess.retryCount}/3</b>
⏰ Berakhir: <i>${expiryText}</i>${noteText}
━━━━━━━━━━━━━━━━
⏳ Menunggu OTP baru...</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: retryButtons,
        },
      }
    ).catch(() => {});
    wahubSessionDb.set(uid, sess);
  } finally {
    const latest = getWahubSession(uid, sessionKey || sess.sessionKey);
    if (latest?.retryProcessing) {
      latest.retryProcessing = false;
      wahubSessionDb.set(uid, latest);
    }
    const current = getWahubSession(uid, sessionKey || sess.sessionKey);
    if (isWahubWaitingSession(current)) {
      stopWahubPoll(`${String(uid)}:${current.sessionKey || current.trxId || "legacy"}`);
      pollWahub(uid, current.sessionKey || current.trxId);
    }
  }
});

// Only timer handles live in memory. The order itself is read from
// sessions.json on every poll, so a restart can restore the exact same job.
const wahubPollers = new Map();

function stopWahubPoll(uid) {
  const interval = wahubPollers.get(String(uid));
  if (interval) clearInterval(interval);
  wahubPollers.delete(String(uid));
}

function pollWahub(uid, sessionKey = null) {
  const key = String(uid);
  const pollKey = `${key}:${sessionKey || "legacy"}`;
  const initial = getWahubSession(uid, sessionKey);
  if (!isWahubWaitingSession(initial)) return;

  const pollId = Number(initial.pollId || 0) + 1;
  initial.pollId = pollId;
  wahubSessionDb.set(uid, initial);
  let inFlight = false;
  const interval = setInterval(async () => {
    const sess = getWahubSession(uid, sessionKey || initial.sessionKey);
    if (!isWahubWaitingSession(sess) || sess.pollId !== pollId) {
      stopWahubPoll(`${String(uid)}:${sessionKey || initial.sessionKey || "legacy"}`);
      return;
    }
    if (sess.cancelProcessing || sess.retryProcessing) return;
    if (inFlight) return;
    inFlight = true;
    try {
      if (Date.now() >= sess.expiresAt) {
        if (!isWahubWaitingSession(sess)) return;
        if (sess.hasReceivedOtp || isWahubPaidSession(sess)) {
          stopWahubPoll(pollKey);
          saveWahubStatus(uid, sess, "paid", {
            step: "selesai",
            providerStatus: "paid",
            finishedAt: new Date().toISOString(),
          });
          await bot.telegram.sendMessage(
            uid,
            `<blockquote>✅ <b>WAKTU MINTA ULANG OTP BERAKHIR</b>\n━━━━━━━━━━━━━━━━\n📱 Nomor: <code>${escapeHTML(sess.phone)}</code>\nWaktu tunggu OTP telah berakhir. Order telah ditandai selesai dan coin tidak dikembalikan karena OTP sudah berhasil diterima sebelumnya.</blockquote>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
          return;
        }
        sess.cancelProcessing = true;
        wahubSessionDb.set(uid, sess);
        const cancelResult = await cancelWahubOrder(sess.orderId, sess);
        const latest = getWahubSession(uid, sessionKey || initial.sessionKey);
        if (!isWahubWaitingSession(latest)) {
          if (isWahubPaidSession(latest) || latest.hasReceivedOtp) {
            stopWahubPoll(pollKey);
            latest.cancelProcessing = false;
            wahubSessionDb.set(uid, latest);
            await bot.telegram.sendMessage(
              uid,
              `<blockquote>✅ <b>ORDER SUDAH PAID</b>
OTP sudah diterima. Pembatalan otomatis ditolak dan coin tidak dikembalikan.</blockquote>`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          }
          return;
        }
        if (cancelResult.confirmed) {
          const refund = refundWahubOrder(uid, latest);
          if (refund.refunded || refund.alreadyRefunded) {
            stopWahubPoll(pollKey);
            saveWahubStatus(uid, latest, "cancelled", {
              step: "selesai",
              providerStatus: "cancelled",
              cancelledAt: new Date().toISOString(),
              cancelResponse: cancelResult.response,
            });
            await bot.telegram.sendMessage(
              uid,
              `<blockquote>⚠️ <b>OTP tidak masuk dalam 20 menit.</b>
Order otomatis dibatalkan dan coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          }
        } else if (!latest.autoCancelNoticeSent) {
          latest.autoCancelNoticeSent = true;
          wahubSessionDb.set(uid, latest);
          await bot.telegram.sendMessage(
            uid,
            `<blockquote>⚠️ Waktu OTP sudah habis, tetapi provider belum mengonfirmasi pembatalan.
Sistem akan mengirim ulang permintaan pembatalan otomatis.
Coin dikembalikan setelah pembatalan provider dikonfirmasi.</blockquote>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        }
        const afterAutoCancel = getWahubSession(uid, sessionKey || initial.sessionKey);
        if (afterAutoCancel?.step === "tunggu_otp" && afterAutoCancel.cancelProcessing) {
          afterAutoCancel.cancelProcessing = false;
          wahubSessionDb.set(uid, afterAutoCancel);
        }
        return;
      }

      if (!isWahubWaitingSession(sess)) return;
      let otp = "";
      let fullMessage = "";
      let state = "";

      if (sess.provider === "engineunicorn") {
        const orderInfo = await engineunicorn.getOrder(sess.orderId);
        if (orderInfo) {
          state = orderInfo.state;
          otp = orderInfo.otp || "";
          fullMessage = orderInfo.message || "";
        }
      } else {
        const result = await wahub.checkSms(sess.token, sess.orderId);
        state = normalizeWahubStatus(result?.state || "");
        otp = wahub.normalizeOtp(result?.otp) || wahub.extractOtp(result?.message);
        fullMessage = result?.message || "";

        if (!otp && (state === "paid" || state === "success")) {
          const orderInfo = await wahub.getOrder(sess.token) || (sess.orderId ? await wahub.getOrder(sess.orderId) : null);
          otp = wahub.normalizeOtp(orderInfo?.otp) || wahub.extractOtp(orderInfo?.message);
          if (orderInfo?.message) fullMessage = orderInfo.message;
        }
      }

      const latest = getWahubSession(uid, sessionKey || initial.sessionKey);
      if (!isWahubWaitingSession(latest)) {
        if (isWahubPaidSession(latest)) stopWahubPoll(pollKey);
        return;
      }

      if (otp) {
        stopWahubPoll(pollKey);
        saveWahubStatus(uid, sess, "paid", {
          step: "selesai",
          providerStatus: "paid",
          paidAt: sess.paidAt || new Date().toISOString(),
          hasReceivedOtp: true,
          otpReceived: true,
          firstOtp: sess.firstOtp || otp,
          lastOtp: otp,
        });
        const finalMsg = fullMessage || `OTP: ${otp}`;

        // Siarkan Notifikasi Realtime OTP ke Channel
        sendChannelRealtimeOtpNotification({
          serviceName: sess.serviceName,
          phone: sess.phone,
          otp: otp,
          trxId: sess.trxId,
        });

        // Siarkan Laporan Order OTP ke Channel Khusus
        const serverLabel = sess.provider === "engineunicorn" ? "Server 2 (WhatsApp)" : "Server 1 (WhatsApp)";
        const userObj = db.getUser(uid);
        const username = sess.username || sess.testimoniData?.username || userObj?.username || "";
        sendChannelOrderReportNotification({
          type: "WHATSAPP",
          username: username,
          userId: uid,
          serviceName: sess.serviceName,
          phone: sess.phone,
          harga: sess.hargaUser,
          modal: sess.providerPrice,
          otp: otp,
          serverName: serverLabel,
        }).catch(() => {});

        await bot.telegram.sendMessage(
          uid,
          `<blockquote>🔑 <b>OTP MASUK!</b>
━━━━━━━━━━━━━━━━
📱 Nomor: <code>${escapeHTML(sess.phone)}</code>
🔑 Kode: <code>${escapeHTML(otp)}</code>
━━━━━━━━━━━━━━━━</blockquote>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [copyOtpButton(otp)],
                [{ text: "✅ Pesanan Berhasil", callback_data: `order_done_${uid}_${sess.sessionKey || sess.trxId}` }],
                ...(sess.trxId ? [[{ text: "🛒 Order Lagi", callback_data: `order_again_${uid}_${sess.trxId}` }]] : []),
                ...(wahubRetryCount(sess) < 3
                  ? [[{ text: `🔁 Minta Ulang OTP (${sess.retryCount || 0}/3)`, callback_data: `wahub_retry_${uid}_${sess.sessionKey || sess.trxId}` }]]
                  : []),
              ],
            },
          }
        ).catch(() => {});
        checkResellerPromotion(bot, uid).catch(() => {});
        return;
      }

      if (["failed", "error", "cancelled", "canceled", "expired"].includes(state)) {
        stopWahubPoll(pollKey);
        if (isWahubPaidSession(latest)) {
          saveWahubStatus(uid, latest, "paid", {
            step: "selesai",
            providerStatus: state,
            finishedAt: new Date().toISOString(),
          });
          return;
        }
        const refund = refundWahubOrder(uid, latest);
        saveWahubStatus(uid, latest, state, {
          step: "selesai",
          finishedAt: new Date().toISOString(),
        });
        await bot.telegram.sendMessage(
          uid,
          `<blockquote>⚠️ <b>Order gagal.</b>
${refund.refunded || refund.alreadyRefunded ? "Coin dikembalikan 100%." : "Coin tidak dikembalikan."}
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        return;
      } else if (state) {
        saveWahubStatus(uid, latest, "waiting", { providerStatus: state });
      }
    } catch (error) {
      console.error("WAHUB poll error:", error.message);
    } finally {
      inFlight = false;
    }
  }, 10_000);
  wahubPollers.set(pollKey, interval);
}

// ── Ganti Nomor (Batalkan nomor lama di provider, pesan nomor baru untuk layanan sama tanpa potong saldo lagi) ──
bot.action(/^wahub_change_num_(\d+)(?:_(.+))?$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  const sessionKey = ctx.match[2] || null;
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  const sess = getWahubSession(uid, sessionKey) || getWahubSession(uid);
  if (!sess) {
    return ctx.answerCbQuery("❌ Order tidak ditemukan atau sudah selesai.", { show_alert: true });
  }
  if (isWahubPaidSession(sess)) {
    return ctx.answerCbQuery(
      "❌ Ganti nomor ditolak. OTP sudah diterima dan coin tidak dapat dikembalikan.",
      { show_alert: true }
    );
  }
  if (sess.changeNumProcessing || sess.cancelProcessing || sess.retryProcessing) {
    return ctx.answerCbQuery("⏳ Permintaan sedang diproses. Mohon tunggu.", { show_alert: true });
  }

  sess.changeNumProcessing = true;
  wahubSessionDb.set(uid, sess);
  await ctx.answerCbQuery("⏳ Membatalkan nomor lama & mengambil nomor baru...");

  const oldSessionKey = sessionKey || sess.sessionKey || "legacy";
  const oldOrderId = sess.orderId;
  const serviceId = sess.serviceId;
  const serviceName = sess.serviceName;
  const provider = sess.provider || "wahub";
  const price = sess.hargaUser;
  const providerPrice = sess.providerPrice || price;

  try {
    const current = getWahubSession(uid, sessionKey || sess.sessionKey) || sess;
    if (isWahubPaidSession(current)) {
      stopWahubPoll(`${String(uid)}:${oldSessionKey}`);
      return ctx.answerCbQuery(
        "❌ Ganti nomor ditolak. OTP sudah diterima dan coin tidak dapat dikembalikan.",
        { show_alert: true }
      );
    }

    // 1. Batalkan nomor lama di provider
    const cancelResult = await cancelWahubOrder(oldOrderId, sess);
    if (!cancelResult.confirmed) {
      return ctx.answerCbQuery("❌ Pembatalan nomor lama belum dikonfirmasi provider. Coba lagi.", { show_alert: true });
    }
    stopWahubPoll(`${String(uid)}:${oldSessionKey}`);

    // 2. Sewa nomor baru dari provider yang sama (saldo user TIDAK dipotong lagi karena sudah bayar untuk order ini)
    let newOrder = null;
    let orderError = "";
    try {
      if (provider === "engineunicorn") {
        newOrder = await engineunicorn.rent(serviceId);
        if (!newOrder?.order_id || !newOrder.phone) {
          orderError = engineunicorn.getLastError() || "Stok nomor Server 2 habis.";
        }
      } else {
        newOrder = await wahub.rent(serviceId);
        if (!newOrder?.order_id || !newOrder.phone) {
          orderError = wahub.getLastError() || "Stok nomor Server 1 habis.";
        }
      }
    } catch (err) {
      orderError = err.message;
    }

    if (!newOrder?.phone || !newOrder?.order_id) {
      // Gagal sewa nomor baru pengganti -> refund saldo order lama 100%
      const refund = refundWahubOrder(uid, sess);
      saveWahubStatus(uid, sess, "cancelled", {
        step: "selesai",
        providerStatus: "cancelled",
        cancelledAt: new Date().toISOString(),
        cancelResponse: cancelResult.response,
      });
      const failedText = `<blockquote>🚫 <b>NOMOR LAMA DIBATALKAN</b>
━━━━━━━━━━━━━━━━
Nomor lama berhasil dibatalkan dan koin telah di-refund 100%.
❌ <b>Gagal ganti nomor baru:</b> ${escapeHTML(orderError || "Stok nomor sedang kosong.")}
🪙 Sisa Coin: <b>${rupiah(db.getCoin(uid))}</b>
━━━━━━━━━━━━━━━━
Silakan pilih layanan lain atau coba lagi nanti.</blockquote>`;
      return ctx.editMessageText(failedText, { parse_mode: "HTML" }).catch(() => ctx.replyWithHTML(failedText));
    }

    // 3. Sewa nomor baru sukses -> Update info transaksi & sesi (Saldo user TIDAK dipotong lagi!)
    const trx = db.getTrxById(sess.trxId);
    if (trx) {
      trx.phone = newOrder.phone;
      trx.orderId = newOrder.order_id;
      if (providerPrice) trx.providerPrice = providerPrice;
      db.save(db.load());
    }

    const expiryMs = wahubExpiryMs(newOrder.expires_at);
    sess.orderId = newOrder.order_id;
    sess.token = newOrder.token || newOrder.order_id;
    sess.phone = newOrder.phone;
    sess.expiresAt = expiryMs;
    sess.cancelAt = 0;
    sess.retryCount = 0;
    sess.step = "tunggu_otp";
    sess.status = "waiting";
    sess.providerStatus = "waiting";
    sess.lastOtp = "";
    sess.firstOtp = "";
    sess.hasReceivedOtp = false;
    sess.otpReceived = false;
    sess.paidAt = null;
    sess.changeNumProcessing = false;
    sess.updatedAt = new Date().toISOString();
    if (sess.testimoniData) {
      sess.testimoniData.phone = newOrder.phone;
    }
    wahubSessionDb.set(uid, sess);

    const expiryText = new Date(expiryMs).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const successText = `<blockquote>🔄 <b>NOMOR BERHASIL DIGANTI!</b>
━━━━━━━━━━━━━━━━
🔧 Layanan: <b>${escapeHTML(serviceName)}</b>
📱 Nomor Baru: <code>${escapeHTML(newOrder.phone)}</code>
💰 Harga: <b>${rupiah(price)}</b>
🪙 Sisa coin: <b>${rupiah(db.getCoin(uid))}</b>
🧾 TRX ID: <code>${sess.trxId}</code>
⏰ Berakhir: <i>${expiryText}</i>
━━━━━━━━━━━━━━━━
⏳ Menunggu OTP masuk ke nomor baru...

💡 Saldo kamu tidak dipotong lagi. Jika OTP tidak masuk, kamu bisa batalkan order kapan saja (Saldo di-refund 100%).</blockquote>`;

    await ctx.editMessageText(successText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔁 Minta Ulang OTP (0/3)", callback_data: `wahub_retry_${uid}_${sess.sessionKey || sess.trxId}` }],
          [{ text: "🔄 Ganti Nomor", callback_data: `wahub_change_num_${uid}_${sess.sessionKey || sess.trxId}` }],
          [{ text: "🚫 Batalkan Order", callback_data: `wahub_cancel_${uid}_${sess.sessionKey || sess.trxId}` }],
        ],
      },
    }).catch(() => ctx.replyWithHTML(successText));

    pollWahub(uid, sess.sessionKey || sess.trxId);
  } finally {
    const latest = getWahubSession(uid, sessionKey || sess.sessionKey) || sess;
    if (latest?.changeNumProcessing) {
      latest.changeNumProcessing = false;
      wahubSessionDb.set(uid, latest);
    }
  }
});

bot.action(/^wahub_cancel_(\d+)(?:_(.+))?$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  const sessionKey = ctx.match[2] || null;
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  const sess = getWahubSession(uid, sessionKey) || getWahubSession(uid);
  if (!sess) {
    return ctx.answerCbQuery("❌ Order tidak ditemukan atau sudah selesai.", { show_alert: true });
  }
  if (isWahubPaidSession(sess) || sess.hasReceivedOtp || sess.otpReceived || sess.firstOtp || sess.paidAt) {
    return ctx.answerCbQuery(
      "❌ Pembatalan ditolak. OTP sudah diterima dan coin tidak dapat dikembalikan.",
      { show_alert: true }
    );
  }
  if (sess.cancelProcessing) return ctx.answerCbQuery("⏳ Sedang diproses.", { show_alert: true });
  sess.cancelProcessing = true;
  wahubSessionDb.set(uid, sess);
  await ctx.answerCbQuery("⏳ Membatalkan order...");
  try {
    const current = getWahubSession(uid, sessionKey || sess.sessionKey) || sess;
    if (isWahubPaidSession(current) || current.hasReceivedOtp || current.otpReceived || current.firstOtp || current.paidAt) {
      stopWahubPoll(`${String(uid)}:${sessionKey || sess.sessionKey || "legacy"}`);
      return ctx.answerCbQuery(
        "❌ Pembatalan ditolak. OTP sudah diterima dan coin tidak dapat dikembalikan.",
        { show_alert: true }
      );
    }
    const cancelResult = await cancelWahubOrder(sess.orderId, sess);
    if (!cancelResult.confirmed) {
      return ctx.answerCbQuery("❌ Pembatalan belum dikonfirmasi provider.", { show_alert: true });
    }
    const latest = getWahubSession(uid, sessionKey || sess.sessionKey) || sess;
    if (isWahubPaidSession(latest)) {
      stopWahubPoll(`${String(uid)}:${sessionKey || sess.sessionKey || "legacy"}`);
      latest.cancelProcessing = false;
      wahubSessionDb.set(uid, latest);
      return ctx.answerCbQuery(
        "❌ Pembatalan ditolak. OTP sudah diterima dan coin tidak dapat dikembalikan.",
        { show_alert: true }
      );
    }
    const refund = refundWahubOrder(uid, latest);
    if (!refund.refunded && !refund.alreadyRefunded) {
      return ctx.answerCbQuery("❌ Refund belum dapat diproses. Hubungi admin.", { show_alert: true });
    }
    const refundAmount = refund.amount || latest.hargaUser || 0;
    stopWahubPoll(`${String(uid)}:${sessionKey || sess.sessionKey || "legacy"}`);
    saveWahubStatus(uid, latest, "cancelled", {
      step: "selesai",
      providerStatus: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelResponse: cancelResult.response,
    });
    const refundStatusText = refund.alreadyRefunded
      ? "<i>(Sudah di-refund otomatis sebelumnya)</i>"
      : `<b>${rupiah(refundAmount)}</b>`;
    const cancelText = `<blockquote>🚫 <b>ORDER DIBATALKAN</b>
━━━━━━━━━━━━━━━━
📱 Layanan: <b>${escapeHTML(latest.serviceName || "-")}</b>
📞 Nomor: <code>${escapeHTML(latest.phone || "-")}</code>
🧾 TRX ID: <code>${escapeHTML(latest.trxId || "-")}</code>
🪙 Coin dikembalikan: ${refundStatusText}
💰 Sisa coin: <b>${rupiah(db.getCoin(uid))}</b>
━━━━━━━━━━━━━━━━
Order berhasil dibatalkan dan saldo telah di-refund 100%.</blockquote>`;
    await ctx.editMessageText(
      cancelText,
      { parse_mode: "HTML" }
    ).catch(() => ctx.replyWithHTML(cancelText));
  } finally {
    const latest = getWahubSession(uid, sessionKey || sess.sessionKey) || sess;
    if (latest?.cancelProcessing) {
      latest.cancelProcessing = false;
      wahubSessionDb.set(uid, latest);
    }
  }
});

bot.action(/^wahub_cancel_all_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  await ctx.answerCbQuery("⏳ Membatalkan semua order...");
  const activeOrders = getActiveWahubSessions(uid);
  if (!activeOrders.length) {
    return ctx.reply("❌ Tidak ada order aktif yang dapat dibatalkan.");
  }
  let totalRefund = 0;
  let cancelCount = 0;
  for (const sess of activeOrders) {
    if (isWahubPaidSession(sess)) {
      saveWahubStatus(uid, sess, "paid", {
        step: "selesai",
        finishedAt: new Date().toISOString(),
      });
      stopWahubPoll(`${String(uid)}:${sess.sessionKey || sess.trxId || "legacy"}`);
      continue;
    }
    try {
      await cancelWahubOrder(sess.orderId, sess);
      const refund = refundWahubOrder(uid, sess);
      if (refund.refunded) {
        totalRefund += refund.amount || sess.hargaUser || 0;
        cancelCount++;
      } else if (refund.alreadyRefunded) {
        cancelCount++;
      }
      stopWahubPoll(`${String(uid)}:${sess.sessionKey || sess.trxId || "legacy"}`);
      saveWahubStatus(uid, sess, "cancelled", {
        step: "selesai",
        providerStatus: "cancelled",
        cancelledAt: new Date().toISOString(),
      });
    } catch (e) {}
  }
  const cancelAllText = `<blockquote>🚫 <b>SEMUA ORDER DIBATALKAN</b>
━━━━━━━━━━━━━━━━
✅ Berhasil membatalkan <b>${cancelCount} order</b>.
🪙 Total coin di-refund: <b>${rupiah(totalRefund)}</b>
💰 Saldo coin sekarang: <b>${rupiah(db.getCoin(uid))}</b>
━━━━━━━━━━━━━━━━
Semua saldo order yang belum menerima OTP telah dikembalikan 100%.</blockquote>`;
  await ctx.editMessageText(
    cancelAllText,
    { parse_mode: "HTML" }
  ).catch(() => ctx.replyWithHTML(cancelAllText));
});

bot.action(/^wahub_force_new_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  if (wahubSessionLimitReached(uid)) {
    return ctx.answerCbQuery(
      `⚠️ Batas sessions order tercapai (maksimal ${MAX_WAHUB_SESSIONS}).`,
      { show_alert: true }
    );
  }
  const services = (await wahub.getServices()).filter((service) => service.stock > 0);
  if (!services.length) {
    return ctx.replyWithHTML(
      `<blockquote>⚠️ <b>Layanan sedang tidak tersedia.</b>\n${escapeHTML(wahub.getLastError() || "Stok sedang habis, coba lagi nanti.")}</blockquote>`
    );
  }
  sessions[uid] = { step: "wahub_pilih_service", wahubServices: services, servicePage: 1 };
  return showWahubServices(ctx, uid);
});

// ── Poll OTP lama (dipertahankan hanya untuk sesi lama) ───
function pollOtpcepat(uid, orderId, phone, sess) {
  let found    = false;
  let inFlight = false;
  const expiry = Date.now() + OTP_WAIT_MS;

  const iv = setInterval(async () => {
    if (found) return clearInterval(iv);
    if (inFlight) return;
    inFlight = true;
    if (Date.now() > expiry) {
      clearInterval(iv);
      try {
        if (!found) {
          const cancelResult = await otpcepat.cancelOrder(orderId).catch(() => null);
          if (cancelResult === null) {
            await bot.telegram.sendMessage(uid,
`<blockquote>⚠️ <b>Order belum berhasil dibatalkan otomatis.</b>
Provider belum mengonfirmasi pembatalan.
Coin belum dikembalikan sampai pembatalan benar-benar berhasil.
💬 Hubungi: ${config.urladmin}</blockquote>`,
              { parse_mode: "HTML" }
            ).catch(() => {});
            return;
          }
          const trxTimeout = db.getTrxById(sess.trxId);
          if (trxTimeout && !trxTimeout.refunded) {
            db.markRefunded(sess.trxId);
            db.addCoin(uid, sess.hargaUser);
          }
          await bot.telegram.sendMessage(uid,
`<blockquote>⚠️ <b>OTP tidak masuk dalam 20 menit.</b>
Order dibatalkan & coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
          delete sessions[uid];
        }
      } finally {
        inFlight = false;
      }
      return;
    }

    try {
      const order = await otpcepat.getOrder(orderId);
      if (!order) return;

      const otpCode = order.otp_code || otpcepat.extractOtp(order.sms);
      if (otpCode) {
        found = true;
        clearInterval(iv);
        await bot.telegram.sendMessage(
          uid,
          `<blockquote>🔑 <b>OTP MASUK!</b>
━━━━━━━━━━━━━━━━
📱 Nomor: <code>${phone}</code>
🔑 Kode: <code>${otpCode}</code>
━━━━━━━━━━━━━━━━</blockquote>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [copyOtpButton(otpCode)],
                [{ text: "✅ Pesanan Berhasil", callback_data: `order_done_${uid}_${sess.trxId || orderId}` }],
                ...(sess.trxId ? [[{ text: "🛒 Order Lagi", callback_data: `order_again_${uid}_${sess.trxId}` }]] : []),
              ],
            },
          }
        );
        sendChannelRealtimeOtpNotification({
          serviceName: sess.serviceName,
          phone,
          otp: otpCode,
          trxId: sess.trxId || orderId,
        }).catch(() => {});

        const userObj = db.getUser(uid);
        sendChannelOrderReportNotification({
          type: "SMS",
          username: userObj?.username || "",
          userId: uid,
          serviceName: sess.serviceName,
          phone,
          harga: sess.hargaUser,
          modal: sess.hargaAsli || sess.providerPrice,
          otp: otpCode,
          serverName: "Server 1 (SMS - OTPCepat)",
        }).catch(() => {});

        await otpcepat.finishOrder(orderId).catch(() => {});
        delete sessions[uid];
        checkResellerPromotion(bot, uid).catch(() => {});
      }

      const status = String(order.status || "").toLowerCase();
      if (["canceled", "cancelled", "cancel", "expired", "failed", "error"].includes(status)) {
        clearInterval(iv);
        found = true;
        const trxTimeout = db.getTrxById(sess.trxId);
        if (trxTimeout && !trxTimeout.refunded) {
          db.markRefunded(sess.trxId);
          db.addCoin(uid, sess.hargaUser);
        }
        await bot.telegram.sendMessage(uid,
`<blockquote>⚠️ Order ${escapeHTML(order.status)}. Coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        delete sessions[uid];
      }
    } catch (e) {
      console.error("OTP Cepat poll error:", e.message);
    } finally {
      inFlight = false;
    }
  }, 10_000);
}

function refundHeroSmsOrder(uid, sess) {
  const trx = db.getTrxById(sess.trxId);
  if (trx && !trx.refunded) {
    db.markRefunded(sess.trxId);
    db.addCoin(uid, sess.hargaUser);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelHeroSmsOrder(orderId) {
  // Coba ulang agar gangguan jaringan singkat tidak membuat order menggantung.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await herosms.cancelOrder(orderId);
    if (result !== null) return result;
    if (attempt < 3) await sleep(1000);
  }
  return null;
}

function extractOtp(text) {
  const match = String(text || "").match(/(?:^|\D)((?:\d[\s-]?){4,8})(?:\D|$)/);
  if (!match) return "";
  const code = match[1].replace(/[\s-]/g, "");
  return /^\d{4,8}$/.test(code) ? code : "";
}

function rememberFullSms(uid, orderId, text) {
  const token = `${uid}_${String(orderId).replace(/[^a-zA-Z0-9_-]/g, "")}_${Date.now().toString(36)}`;
  fullSmsMessages.set(token, {
    userId: uid,
    text: String(text || ""),
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  setTimeout(() => fullSmsMessages.delete(token), 10 * 60 * 1000);
  return token;
}

// ── Poll OTP server 2 ────────────────────────────────────
function pollHeroSms(uid, orderId, phone, sess) {
  let found = false;
  // Batas bot selalu 20 menit, walaupun expired_at provider lebih lama.
  const expiry = Date.now() + OTP_WAIT_MS;

  const iv = setInterval(async () => {
    if (found) return clearInterval(iv);
    if (sessions[uid] !== sess || sess.step !== "tunggu_otp") {
      found = true;
      return clearInterval(iv);
    }

    if (Date.now() > expiry) {
      clearInterval(iv);
      if (found) return;
      found = true;
      sess.cancelProcessing = true;
       const cancelResult = await cancelHeroSmsOrder(orderId);
      if (cancelResult === null) {
        sess.cancelProcessing = false;
        found = false;
        await bot.telegram.sendMessage(
          uid,
`<blockquote>❌ <b>Order belum berhasil dibatalkan otomatis.</b>
Provider tidak merespons setelah 3 percobaan.
Silakan tekan tombol batalkan lagi.</blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        return;
      }

       refundHeroSmsOrder(uid, sess);
      await bot.telegram.sendMessage(
        uid,
`<blockquote>⚠️ <b>OTP tidak masuk dalam 20 menit.</b>
Order otomatis dibatalkan.
Coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      delete sessions[uid];
      return;
    }

    try {
       const order = await herosms.getOrder(orderId);
      if (!order) return;

      // Jangan menganggap pesan informasi seperti "Silahkan copy..." sebagai OTP.
      // Tunggu sampai ada kode numerik yang benar-benar bisa dikirim ke user.
      const otpCode = order.otp_code || extractOtp(order.otp_msg);
      const hasOtp = Boolean(otpCode);
      if (hasOtp) {
        found = true;
        clearInterval(iv);
        const isFlashcall = sess.smsServer === 2 || sess.verificationType === "flashcall" || Boolean(order.is_call);
        const otpTitle = order.is_call ? "📞 <b>FLASHCALL / PANGGILAN MASUK!</b>" : "🔑 <b>OTP MASUK!</b>";
        const methodLine = order.is_call
          ? "⚡ Metode: <b>📞 FlashCall (Panggilan)</b>\n"
          : isFlashcall
          ? "⚡ Metode: <b>📞 FlashCall + 📩 SMS</b>\n"
          : "⚡ Metode: <b>📩 SMS</b>\n";

        await bot.telegram.sendMessage(
          uid,
          `<blockquote>${otpTitle}
━━━━━━━━━━━━━━━━
📱 Nomor: <code>${phone}</code>
${methodLine}🔑 Kode: <code>${otpCode}</code>
━━━━━━━━━━━━━━━━</blockquote>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [copyOtpButton(otpCode)],
                [{ text: "✅ Pesanan Berhasil", callback_data: `order_done_${uid}_${sess.trxId || orderId}` }],
                ...(sess.trxId ? [[{ text: "🛒 Order Lagi", callback_data: `order_again_${uid}_${sess.trxId}` }]] : []),
              ],
            },
          }
        );
        sendChannelRealtimeOtpNotification({
          serviceName: sess.serviceName,
          phone,
          otp: otpCode,
          trxId: sess.trxId || orderId,
        }).catch(() => {});

        const userObj = db.getUser(uid);
        const serverReportName = isFlashcall ? "Server 2 (SMS - FlashCall + SMS)" : "Server 1 (SMS)";
        sendChannelOrderReportNotification({
          type: "SMS",
          username: userObj?.username || "",
          userId: uid,
          serviceName: sess.serviceName,
          phone,
          harga: sess.hargaUser,
          modal: sess.hargaAsli || sess.providerPrice,
          otp: otpCode,
          serverName: serverReportName,
        }).catch(() => {});
        delete sessions[uid];
        checkResellerPromotion(bot, uid).catch(() => {});
        return;
      }

      const status = String(order.status || "").toLowerCase();
      if (["canceled", "cancelled", "cancel", "expired", "expiring"].includes(status)) {
        clearInterval(iv);
        found = true;
        refundHeroSmsOrder(uid, sess);
        await bot.telegram.sendMessage(
          uid,
`<blockquote>⚠️ Order ${escapeHTML(order.status)}.
Coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        delete sessions[uid];
      }
    } catch (error) {
      console.error("Server 2 poll error:", error.message);
    }
  }, 10_000);
}

// ── Poll OTP RumahOTP (Server 2 SMS) ──────────────────────
function refundRumahOtpOrder(uid, sess) {
  const trx = db.getTrxById(sess.trxId);
  if (trx && !trx.refunded) {
    db.markRefunded(sess.trxId);
    db.addCoin(uid, sess.hargaUser);
  }
}

async function cancelRumahOtpOrder(orderId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await rumahotp.cancelOrder(orderId);
    if (result) return true;
    if (attempt < 3) await sleep(1000);
  }
  return null;
}

function pollRumahOtpSession(uid, orderId, phone, sess) {
  let found = false;
  const expiry = Date.now() + OTP_WAIT_MS;

  const iv = setInterval(async () => {
    if (found) return clearInterval(iv);
    if (sessions[uid] !== sess || sess.step !== "tunggu_otp") {
      found = true;
      return clearInterval(iv);
    }

    if (Date.now() > expiry) {
      clearInterval(iv);
      if (found) return;
      found = true;
      sess.cancelProcessing = true;
      const cancelResult = await cancelRumahOtpOrder(orderId);
      if (cancelResult === null) {
        sess.cancelProcessing = false;
        found = false;
        await bot.telegram.sendMessage(
          uid,
`<blockquote>❌ <b>Order belum berhasil dibatalkan otomatis.</b>
Provider tidak merespons setelah 3 percobaan.
Silakan tekan tombol batalkan lagi.</blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        return;
      }

      refundRumahOtpOrder(uid, sess);
      await bot.telegram.sendMessage(
        uid,
`<blockquote>⚠️ <b>OTP tidak masuk dalam 20 menit.</b>
Order otomatis dibatalkan.
Coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      delete sessions[uid];
      return;
    }

    try {
      const order = await rumahotp.getOrder(orderId);
      if (!order) return;

      const otpCode = order.otp_code || rumahotp.normalizeOtpCode(order.otp) || extractOtp(order.sms);
      const hasOtp = Boolean(otpCode);
      if (hasOtp) {
        found = true;
        clearInterval(iv);
        await bot.telegram.sendMessage(
          uid,
          `<blockquote>🔑 <b>OTP MASUK!</b>
━━━━━━━━━━━━━━━━
📱 Nomor: <code>${phone}</code>
🔑 Kode: <code>${otpCode}</code>
━━━━━━━━━━━━━━━━</blockquote>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [copyOtpButton(otpCode)],
                [{ text: "✅ Pesanan Berhasil", callback_data: `order_done_${uid}_${sess.trxId || orderId}` }],
                ...(sess.trxId ? [[{ text: "🛒 Order Lagi", callback_data: `order_again_${uid}_${sess.trxId}` }]] : []),
              ],
            },
          }
        );
        sendChannelRealtimeOtpNotification({
          serviceName: sess.serviceName,
          phone,
          otp: otpCode,
          trxId: sess.trxId || orderId,
        }).catch(() => {});

        const userObj = db.getUser(uid);
        sendChannelOrderReportNotification({
          type: "SMS",
          username: userObj?.username || "",
          userId: uid,
          serviceName: sess.serviceName,
          phone,
          harga: sess.hargaUser,
          modal: sess.hargaDasar || sess.providerPrice,
          otp: otpCode,
          serverName: "Server 2 (SMS)",
        }).catch(() => {});
        delete sessions[uid];
        checkResellerPromotion(bot, uid).catch(() => {});
        return;
      }

      const status = String(order.status || "").toLowerCase();
      if (["canceled", "cancelled", "cancel", "expired", "failed"].includes(status)) {
        clearInterval(iv);
        found = true;
        refundRumahOtpOrder(uid, sess);
        await bot.telegram.sendMessage(
          uid,
`<blockquote>⚠️ Order ${escapeHTML(order.status)}.
Coin dikembalikan.
🪙 Coin kamu: <b>${rupiah(db.getCoin(uid))}</b></blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        delete sessions[uid];
      }
    } catch (error) {
      console.error("Server 2 (RumahOTP) poll error:", error.message);
    }
  }, 10_000);
}

// ── Polling Background untuk Order SMS API Dev (FastBit, HeroSMS, RumahOTP) ──
const apiSmsPollers = new Map();

function stopApiSmsPoll(pollKey) {
  const timer = apiSmsPollers.get(String(pollKey));
  if (timer) clearInterval(timer);
  apiSmsPollers.delete(String(pollKey));
}

function pollApiSmsOrder(sess) {
  if (!sess || !sess.orderId || !sess.provider) return;
  const uid = sess.userId;
  const pollKey = `${uid}:${sess.sessionKey || sess.trxId || sess.orderId}`;
  stopApiSmsPoll(pollKey);

  const iv = setInterval(async () => {
    try {
      const current = wahubSessionDb.find(uid, sess.sessionKey || sess.trxId || sess.orderId) || sess;
      if (!current || ["paid", "completed", "cancelled", "expired", "failed"].includes(current.status)) {
        stopApiSmsPoll(pollKey);
        return;
      }

      // Cek timeout (20 menit)
      if (Date.now() >= (current.expiresAt || 0)) {
        stopApiSmsPoll(pollKey);
        if (current.hasReceivedOtp || current.lastOtp) {
          current.status = "completed";
          current.providerStatus = "completed";
          wahubSessionDb.set(uid, current);
          return;
        }
        current.status = "cancelled";
        current.providerStatus = "expired";
        wahubSessionDb.set(uid, current);

        if (current.provider === "fastbit") {
          await cancelFastbitOrder(current.orderId || current.orderUuid).catch(() => {});
        } else if (current.provider === "herosms" || current.provider === "rumahotp") {
          await cancelHeroSmsOrder(current.orderId).catch(() => {});
        }
        if (current.trxId) {
          db.refundTransaction(current.trxId, uid);
        }
        return;
      }

      let otpCode = null;
      let orderData = null;

      if (current.provider === "fastbit") {
        orderData = await fastbit.getOrder(current.orderId || current.orderUuid);
        if (orderData?.otp_code) {
          otpCode = orderData.otp_code;
          fastbit.finishOrder(current.orderId || current.orderUuid).catch(() => {});
        }
      } else if (current.provider === "herosms" || current.provider === "rumahotp") {
        orderData = await herosms.getOrder(current.orderId);
        if (orderData) {
          otpCode = orderData.otp_code || extractOtp(orderData.otp_msg);
        }
      }

      if (otpCode) {
        stopApiSmsPoll(pollKey);
        current.status = "completed";
        current.providerStatus = "completed";
        current.lastOtp = otpCode;
        current.hasReceivedOtp = true;
        current.otpReceived = true;
        current.completedAt = new Date().toISOString();
        wahubSessionDb.set(uid, current);

        if (!current.notifiedRealtime) {
          current.notifiedRealtime = true;
          wahubSessionDb.set(uid, current);

          sendChannelRealtimeOtpNotification({
            serviceName: current.serviceName,
            phone: current.phone,
            otp: otpCode,
            trxId: current.trxId || current.orderId,
          }).catch(() => {});

          const userObj = db.getUser(uid);
          const username = userObj?.username || "API User";
          const serverReportName = current.provider === "fastbit"
            ? "Server 1 (SMS)"
            : "Server 2 (SMS - FlashCall)";

          sendChannelOrderReportNotification({
            type: "SMS",
            username,
            userId: uid,
            serviceName: current.serviceName,
            phone: current.phone,
            harga: current.hargaUser,
            modal: current.providerPrice || current.hargaDasar || 0,
            otp: otpCode,
            serverName: serverReportName,
          }).catch(() => {});
        }

        bot.telegram.sendMessage(
          uid,
          `<blockquote>🔑 <b>OTP MASUK! (API)</b>\n━━━━━━━━━━━━━━━━\n📱 Nomor: <code>${escapeHTML(current.phone)}</code>\n🔑 Kode: <code>${escapeHTML(otpCode)}</code>\n🧾 TRX ID: <code>${escapeHTML(current.trxId || "-")}</code>\n━━━━━━━━━━━━━━━━</blockquote>`,
          { parse_mode: "HTML" }
        ).catch(() => {});

        return;
      }

      const statusStr = String(orderData?.status || "").toLowerCase();
      if (["canceled", "cancelled", "cancel", "failed", "expired"].includes(statusStr)) {
        stopApiSmsPoll(pollKey);
        current.status = "cancelled";
        current.providerStatus = statusStr;
        wahubSessionDb.set(uid, current);
        if (current.trxId) {
          db.refundTransaction(current.trxId, uid);
        }
      }
    } catch (pollErr) {
      console.error("[API SMS POLL ERROR]", pollErr.message);
    }
  }, 6000);

  apiSmsPollers.set(pollKey, iv);
}

// ── Full Pesan ────────────────────────────────────────────
bot.action(/^order_again_(\d+)_(TRX-\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  const trx = db.getTrxById(ctx.match[2]);
  if (!trx || String(trx.userId) !== String(uid) || !trx.provider || !trx.serviceId) {
    return ctx.answerCbQuery("❌ Data order lama tidak ditemukan.", { show_alert: true });
  }
  if (wahubSessionLimitReached(uid)) {
    return ctx.answerCbQuery(
      `⚠️ Batas sessions order tercapai (maksimal ${MAX_WAHUB_SESSIONS}).`,
      { show_alert: true }
    );
  }
  await ctx.answerCbQuery("⏳ Menyiapkan order dengan layanan yang sama...");

  const provider = String(trx.provider).toLowerCase();
  const basePrice = Number(trx.providerPrice);
  const hargaUser = Number(trx.harga);
  if (!Number.isFinite(basePrice) || !Number.isFinite(hargaUser)) {
    return ctx.answerCbQuery("❌ Harga order lama tidak valid.", { show_alert: true });
  }

  if (provider === "wahub") {
    const services = (await wahub.getServices()).filter(item =>
      String(item.id) === String(trx.serviceId) && Number(item.stock) > 0
    );
    if (!services.length) return ctx.reply("❌ Layanan Server 1⃣ yang sama sedang tidak tersedia atau stok habis.");
    return createWahubOrder(ctx, uid, services[0]);
  }

  if (provider === "engineunicorn") {
    const services = (await engineunicorn.getServices()).filter(item =>
      String(item.id) === String(trx.serviceId) && Number(item.stock) > 0
    );
    if (!services.length) return ctx.reply("❌ Layanan Server 2⃣ yang sama sedang tidak tersedia atau stok habis.");
    return createEngineUnicornOrder(ctx, uid, services[0]);
  }

  // Jika order lama berasal dari provider SMS / lainnya:
  return ctx.replyWithHTML(
    "<blockquote>💡 Untuk nomor SMS, silakan pilih nomor baru melalui menu <b>🛒 Beli Nokos</b> ➔ <b>✉️ OTP via SMS</b>.</blockquote>"
  );
});

// ── Pesanan Berhasil (User konfirmasi order selesai) ──────
bot.action(/^order_done_(\d+)(?:_(.+))?$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Tombol ini bukan untuk akun kamu.", { show_alert: true });
  }
  const trxKey = ctx.match[2] || null;
  const sess = getWahubSession(uid, trxKey) || getWahubSession(uid);
  if (sess) {
    sess.finishedAt = new Date().toISOString();
    sess.step = "selesai";
    sess.status = "paid";
    sess.providerStatus = "paid";
    sess.hasReceivedOtp = true;
    sess.otpReceived = true;
    wahubSessionDb.set(uid, sess);
    stopWahubPoll(`${String(uid)}:${sess.sessionKey || sess.trxId || "legacy"}`);
  }

  await ctx.answerCbQuery("✅ Pesanan telah selesai & berhasil! Terima kasih telah menggunakan layanan kami.", { show_alert: true });

  try {
    const currentMarkup = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
    const updatedMarkup = currentMarkup
      .filter((row) => !row.some((btn) => btn.callback_data && btn.callback_data.includes("wahub_retry_")))
      .map((row) =>
        row.map((btn) => {
          if (btn.callback_data && btn.callback_data.startsWith("order_done_")) {
            return { text: "✅ Pesanan Telah Berhasil", callback_data: `order_done_noop_${uid}` };
          }
          return btn;
        })
      );
    await ctx.editMessageReplyMarkup({ inline_keyboard: updatedMarkup });
  } catch (e) {}
});

bot.action(/^order_done_noop_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("✅ Pesanan ini sudah ditandai berhasil.", { show_alert: false });
});

bot.action(/^fm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const saved = fullSmsMessages.get(ctx.match[1]);
  if (!saved || saved.expiresAt <= Date.now()) {
    fullSmsMessages.delete(ctx.match[1]);
    return ctx.reply("❌ Pesan SMS sudah kedaluwarsa.");
  }
  if (saved.userId !== ctx.from.id) {
    return ctx.reply("❌ Pesan ini bukan untuk akun Anda.");
  }
  const msg = await ctx.replyWithHTML(
    `<blockquote>📩 <b>Full Pesan:</b>\n${escapeHTML(saved.text)}</blockquote>`
  );
  setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60000);
});

// ── Cancel Order (user) ───────────────────────────────────
bot.action(/^cancel_order_(\d+)$/, async (ctx) => {
  const uid  = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) {
    return ctx.answerCbQuery("❌ Bukan sesimu!", { show_alert: true });
  }

  const sess = sessions[uid];
  if (!sess || sess.step !== "tunggu_otp") {
    return ctx.answerCbQuery("❌ Tidak ada order aktif.", { show_alert: true });
  }

  if (sess.cancelAt && Date.now() < sess.cancelAt) {
    const sisaDetik = Math.ceil((sess.cancelAt - Date.now()) / 1000);
    const sisaMenit = Math.floor(sisaDetik / 60);
    const detik = sisaDetik % 60;
    return ctx.answerCbQuery(
      `⚠️ Tombol batalkan baru aktif dalam ${sisaMenit}m ${detik}s lagi.`,
      { show_alert: true }
    );
  }

  if (sess.cancelProcessing) {
    return ctx.answerCbQuery("⏳ Sedang diproses...", { show_alert: true });
  }
  sess.cancelProcessing = true;

  try {
    const cancelResult = sess.server === "fastbit"
      ? await cancelFastbitOrder(sess.orderId || sess.orderUuid)
      : sess.server === "herosms"
      ? await cancelHeroSmsOrder(sess.orderId)
      : sess.server === "rumahotp"
      ? await cancelRumahOtpOrder(sess.orderId)
      : await otpcepat.cancelOrder(sess.orderId);

    if (cancelResult === null) {
      sess.cancelProcessing = false;
      return ctx.answerCbQuery("❌ Cancel ditolak provider.", { show_alert: true });
    }

    const trxData = db.getTrxById(sess.trxId);
    if (!trxData) {
      sess.cancelProcessing = false;
      return ctx.answerCbQuery("❌ Data transaksi tidak ditemukan.", { show_alert: true });
    }
    const refundAmount = trxData.harga;

    if (trxData.refunded) {
      sess.cancelProcessing = false;
      delete sessions[uid];
      return ctx.answerCbQuery("❌ Sudah pernah direfund.", { show_alert: true });
    }

    db.markRefunded(sess.trxId);
    db.addCoin(uid, refundAmount);
    const newCoin = db.getCoin(uid);

    delete sessions[uid];

    await ctx.answerCbQuery("✅ Order berhasil dibatalkan.");
    await ctx.editMessageText(
`<blockquote>🚫 <b>ORDER DIBATALKAN</b>
━━━━━━━━━━━━━━━━
🧾 TRX ID : <code>${sess.trxId}</code>
🪙 Coin dikembalikan: <b>${rupiah(refundAmount)}</b>
💰 Sisa coin: <b>${rupiah(newCoin)}</b>
━━━━━━━━━━━━━━━━</blockquote>`,
      { parse_mode: "HTML" }
    );

  } catch (e) {
    sess.cancelProcessing = false;
    console.error("cancel_order error:", e.message);
    await ctx.answerCbQuery("❌ Gagal batalkan. Coba lagi.", { show_alert: true });
  }
});

// ── Menu ──────────────────────────────────────────────────
bot.hears("📋 List Produk", async (ctx) => {
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat...</i></blockquote>");
  await showPublicProductList(ctx, ctx.from.id, "list", 1, loadMsg.message_id);
});

bot.hears("📜 Riwayat Transaksi", async (ctx) => {
  const riwayat = db.getRiwayat(ctx.from.id, 5);
  const coin    = db.getCoin(ctx.from.id);
  if (!riwayat.length) return ctx.replyWithHTML(
    `<blockquote>📜 Belum ada transaksi.\n🪙 Coin kamu: <b>${rupiah(coin)}</b></blockquote>`
  );
  let teks = `<blockquote>📜 <b>RIWAYAT TRANSAKSI</b>\n🪙 Coin: <b>${rupiah(coin)}</b>\n━━━━━━━━━━━━━━━━\n`;
  for (const t of riwayat) {
    teks += `🧾 <code>${t.id}</code>\n   📱 ${sensorPhone(t.phone)} | 💰 ${rupiah(t.harga)}\n   📅 ${new Date(t.date).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n`;
  }
  teks += "━━━━━━━━━━━━━━━━</blockquote>";
  const content = riwayat.map(t =>
    `ID: ${t.id}\nNomor: ${t.phone}\nNegara: ${t.negara}\nHarga: ${rupiah(t.harga)}\nTanggal: ${t.date}`
  ).join("\n---\n");
  await ctx.replyWithHTML(teks);
  await ctx.replyWithDocument(
    { source: Buffer.from(content), filename: `trx_${ctx.from.id}_${Date.now()}.txt` },
    { caption: `📋 ${riwayat.length} transaksi` }
  );
});

bot.hears("❓ Cara Order", async (ctx) => {
  await ctx.replyWithHTML(
`<blockquote>❓ <b>CARA ORDER</b>
━━━━━━━━━━━━━━━━
1️⃣ Deposit coin dulu via <b>🪙 Coin &amp; Deposit</b>
2️⃣ Tekan <b>🛒 Beli Nokos</b>
3️⃣ Pilih negara → layanan → harga
4️⃣ Coin dipotong otomatis
5️⃣ Nomor dikirim langsung
6️⃣ OTP masuk → dikirim ke sini ✅
━━━━━━━━━━━━━━━━
💬 ${config.urladmin}</blockquote>`
  );
});

bot.hears("👑 Top Buyer", async (ctx) => {
  const en     = isEN(ctx.from.id);
  const top    = db.getTopBuyers(10);
  const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  if (!top.length) {
    return ctx.replyWithHTML(
      en
        ? "<blockquote><b>TOP BUYER (Top 10)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n<i>No transaction data available yet.</i></blockquote>"
        : "<blockquote><b>TOP BUYER (10 Teratas)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n<i>Belum ada data transaksi pembelian.</i></blockquote>"
    );
  }

  const items = top.map((b, i) => {
    const badge = numberEmojis[i] || `${i + 1}️⃣`;
    const rawName = b.username || `User ${b.userId}`;
    const displayName = rawName.replace(/^@/, "");
    const orderCount = b.orderCount || b.jumlah || b.trx || 0;
    const totalBelanja = b.totalBelanja || b.total || 0;
    const orderText = en ? `${orderCount} Orders` : `${orderCount} Orderan`;
    const belanjaText = `Belanja : ${rupiah(totalBelanja)}`;

    return `${badge} <b>${escapeHTML(displayName)}</b>\n${orderText}\n${belanjaText}`;
  });

  const title = en
    ? "<b>TOP BUYER (Top 10)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n"
    : "<b>TOP BUYER (10 Teratas)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n";

  await ctx.replyWithHTML(`<blockquote>${title}${items.join("\n\n")}</blockquote>`);
});

bot.hears("✨ Produk Populer", async (ctx) => {
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Memuat...</i></blockquote>");
  await showPublicProductList(ctx, ctx.from.id, "popular", 1, loadMsg.message_id);
});

bot.hears("💬 Admin", async (ctx) => {
  ctx.replyWithHTML(`<blockquote>💬 <b>Hubungi Admin:</b>\n${config.urladmin}</blockquote>`);
});

async function showReferralInfo(ctx) {
  const uid = ctx.from.id;
  const stats = db.getReferralStats(uid);
  const settings = db.getReferralSettings();
  let botUsername = ctx.botInfo?.username;
  if (!botUsername) {
    botUsername = (await bot.telegram.getMe()).username;
  }
  const link = `https://t.me/${botUsername}?start=ref_${stats.code}`;
  const commissionPercent = settings.commissionPercent ?? 10;
  await ctx.replyWithHTML(
    `<blockquote>🎁 <b>PROGRAM REFERRAL</b>
━━━━━━━━━━━━━━━━
Status: <b>${settings.enabled ? "AKTIF" : "NONAKTIF"}</b>
Bonus Daftar   : <b>${rupiah(settings.reward)}</b>
Komisi Deposit : <b>${commissionPercent}%</b> (setiap teman deposit)

🔑 Kode kamu: <code>${escapeHTML(stats.code)}</code>
👥 Referral berhasil: <b>${stats.count}</b>
🪙 Total komisi: <b>${rupiah(stats.earned)}</b>

Bagikan link ini ke teman:
<code>${escapeHTML(link)}</code></blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.url("🔗 Bagikan Link Referral", `https://t.me/share/url?url=${encodeURIComponent(link)}`)],
      [Markup.button.callback("🏆 Top Referral Leaderboard", `show_top_referral_${uid}`)],
    ])
  );
}

async function showTopReferralLeaderboard(ctx, uid, isEdit = false) {
  const top = db.getTopReferrals(10);
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  let listText = "Belum ada data referral.";
  if (top.length > 0) {
    listText = top.map((u, i) => {
      const medal = medals[i] || `${i + 1}.`;
      const name = u.username ? `@${escapeHTML(u.username)}` : `User ${u.userId.slice(0, 4)}***`;
      return `${medal} <b>${name}</b>\n   👥 <b>${u.count}</b> Undangan | 🪙 Komisi: <b>${rupiah(u.earned)}</b>`;
    }).join("\n\n");
  }
  const text = `<blockquote>🏆 <b>TOP REFERRAL LEADERBOARD</b>
━━━━━━━━━━━━━━━━
Berikut 10 pengguna dengan referral & komisi terbanyak:

${listText}
━━━━━━━━━━━━━━━━
💡 <i>Dapatkan komisi ${db.getReferralSettings().commissionPercent || 10}% setiap kali teman yang kamu undang melakukan deposit!</i></blockquote>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Kembali ke Info Referral", `back_referral_${uid}`)],
  ]);

  if (isEdit && ctx.callbackQuery?.message?.message_id) {
    return ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard.reply_markup }).catch(() => ctx.replyWithHTML(text, keyboard));
  }
  return ctx.replyWithHTML(text, keyboard);
}

bot.action(/^show_top_referral_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  return showTopReferralLeaderboard(ctx, uid, true);
});

bot.action(/^back_referral_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  await ctx.deleteMessage().catch(() => {});
  return showReferralInfo(ctx);
});

bot.command(["topreferral", "topref"], async (ctx) => {
  return showTopReferralLeaderboard(ctx, ctx.from.id, false);
});

bot.command(["setreferralcommission", "setkomisi"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const arg = ctx.message.text.trim().split(/\s+/)[1];
  const percent = Number(arg);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return ctx.reply("❌ Format: /setkomisi <0-100>\nContoh: /setkomisi 10");
  }
  db.setReferralCommissionPercent(percent);
  return ctx.replyWithHTML(`<blockquote>✅ Persentase komisi deposit referral berhasil diatur ke <b>${percent}%</b>.</blockquote>`);
});

bot.command("broadcasttopreferral", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const ok = await sendChannelTopReferralNotification();
  if (ok) return ctx.reply("✅ Top Referral berhasil di-broadcast ke channel.");
  return ctx.reply("❌ Gagal broadcast top referral ke channel. Pastikan bot menjadi admin di channel.");
});

bot.command("referral", async (ctx) => {
  if (isOwner(ctx)) {
    const requested = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase();
    if (["on", "aktif", "aktifkan", "off", "nonaktif", "matikan"].includes(requested)) {
      const enabled = ["on", "aktif", "aktifkan"].includes(requested);
      db.setReferralEnabled(enabled);
      return ctx.replyWithHTML(
        `<blockquote>🎁 Referral sekarang <b>${enabled ? "AKTIF" : "NONAKTIF"}</b>.</blockquote>`
      );
    }
  }
  return showReferralInfo(ctx);
});
bot.hears("🎁 Referral", showReferralInfo);

// ── OWNER COMMANDS ─────────────────────────────────────────

function ownerArgs(ctx) {
  return ctx.message.text.trim().split(/\s+/).slice(1);
}

function resolveTargetUser(ctx, args) {
  const replyMsg = ctx.message.reply_to_message;
  if (replyMsg) {
    const text = replyMsg.text || replyMsg.caption || "";
    const matchId = text.match(/(?:User\s*:\s*(?:@\w+\s*)?\((\d+)\)|\((\d+)\)|ID User\s*:\s*(\d+)|<code>(\d+)<\/code>)/i);
    const extractedId = matchId ? (matchId[1] || matchId[2] || matchId[3] || matchId[4]) : null;
    if (extractedId && db.getUser(extractedId)) {
      return { userId: extractedId, rest: args };
    }
    const repliedUserId = replyMsg.from?.id;
    if (repliedUserId && String(repliedUserId) !== String(ctx.botInfo?.id)) {
      return { userId: String(repliedUserId), rest: args };
    }
  }
  const rawId = args.shift();
  if (!rawId) return { userId: null, rest: args };
  if (/^\d+$/.test(rawId)) return { userId: rawId, rest: args };
  const found = db.findUserByUsername(rawId);
  return { userId: found?.id || null, rest: args, searchedUsername: rawId };
}

async function changeUserBalance(ctx, direction) {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const { userId, rest, searchedUsername } = resolveTargetUser(ctx, ownerArgs(ctx));
  if (searchedUsername && !userId) {
    return ctx.reply(`❌ Username ${searchedUsername} belum terdaftar di bot.`);
  }
  const amount = Number(rest[0]);
  if (!userId || !Number.isFinite(amount) || amount <= 0) {
    return ctx.reply(
      `❌ Format: /${direction === "add" ? "addsaldo" : "delsaldo"} <userId/@username> <jumlah>\n` +
      "Contoh: /addsaldo 123456789 50000 atau /addsaldo @username 50000\n" +
      "Atau reply pesan deposit/user lalu kirim: /addsaldo <jumlah>"
    );
  }
  let user = db.getUser(userId);
  if (!user && direction === "add" && /^\d+$/.test(userId)) {
    db.registerUser(userId, String(userId));
    user = db.getUser(userId);
  }
  if (!user) return ctx.reply(`❌ User ${userId} belum terdaftar di bot.`);

  const before = db.getCoin(userId);
  const after = direction === "add" ? db.addCoin(userId, amount) : db.deductCoin(userId, amount);
  if (after === false) return ctx.reply("❌ Saldo user tidak mencukupi untuk dikurangi.");

  const actionText = direction === "add" ? "ditambahkan" : "dikurangi";
  await ctx.replyWithHTML(
    `<blockquote>✅ Saldo berhasil ${actionText}.\n👤 User: <code>${userId}</code>\n` +
    `💰 Sebelum: <b>${rupiah(before)}</b>\n` +
    `🪙 Perubahan: <b>${direction === "add" ? "+" : "-"}${rupiah(amount)}</b>\n` +
    `💳 Sekarang: <b>${rupiah(after)}</b></blockquote>`
  );
  bot.telegram.sendMessage(
    userId,
    `<blockquote>ℹ️ <b>Perubahan saldo</b>\nSaldo kamu ${actionText} sebesar <b>${rupiah(amount)}</b>.\n` +
    `💳 Saldo sekarang: <b>${rupiah(after)}</b></blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

bot.command("addsaldo", (ctx) => changeUserBalance(ctx, "add"));
bot.command("delsaldo", (ctx) => changeUserBalance(ctx, "deduct"));

bot.command(["resetsaldoall", "resetalluser"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const result = db.resetAllBalances(config.OWNER_ID);
  await ctx.replyWithHTML(
    `<blockquote>🔄 <b>RESET SALDO SEMUA USER</b>
━━━━━━━━━━━━━━━━
👥 Total user di-reset: <b>${result.count}</b>
🪙 Total coin dinolkan: <b>${rupiah(result.totalReset)}</b>
━━━━━━━━━━━━━━━━
✅ Semua saldo user telah berhasil diubah menjadi <b>Rp0</b>.</blockquote>`
  );
});

bot.command(["backup", "backupdb"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const loadMsg = await ctx.replyWithHTML("<blockquote>⏳ <i>Sedang membuat file backup database (.zip)...</i></blockquote>");
  const ok = await performDatabaseBackup(ctx.chat.id, true);
  if (loadMsg) {
    bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
  }
  if (!ok) {
    await ctx.reply("❌ Gagal membuat backup database. Silakan cek log server.");
  }
});

bot.command("listuser", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const users = db.getUsers();
  if (!users.length) return ctx.reply("❌ Belum ada user.");
  const pageSize = 30;
  const lines = users.slice(0, pageSize).map((user, index) =>
    `${index + 1}. <code>${user.id}</code> — @${escapeHTML(user.username || "-")}\n` +
    `   Saldo: <b>${rupiah(user.coin)}</b> | TRX: ${user.trx || 0}`
  );
  const suffix = users.length > pageSize ? `\n\n... dan ${users.length - pageSize} user lainnya.` : "";
  await ctx.replyWithHTML(
    `<blockquote>👥 <b>DAFTAR USER (${users.length})</b>\n━━━━━━━━━━━━━━━━\n${lines.join("\n")}${suffix}</blockquote>`
  );
});

bot.command("listtransaksi", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const arg = ownerArgs(ctx)[0];
  let transactions = [];
  let headerTitle = "TRANSAKSI TERBARU";

  if (arg) {
    if (/^\d{6,}$/.test(arg)) {
      // Filter by User ID (e.g. 8766019610)
      transactions = db.getRiwayat(arg, 15);
      headerTitle = `TRANSAKSI USER (${arg})`;
    } else if (arg.startsWith("@")) {
      const user = db.findUserByUsername(arg);
      if (user) {
        transactions = db.getRiwayat(user.id, 15);
        headerTitle = `TRANSAKSI USER (${arg})`;
      } else {
        return ctx.reply(`❌ User ${arg} tidak ditemukan.`);
      }
    } else if (/^\d+$/.test(arg)) {
      const limit = Math.min(Math.max(Number(arg) || 10, 1), 15);
      transactions = db.getTransactions(limit);
    } else {
      transactions = db.getTransactions(10);
    }
  } else {
    transactions = db.getTransactions(10);
  }

  if (!transactions.length) return ctx.reply("❌ Belum ada data transaksi.");

  const lines = transactions.slice(0, 15).map((trx, index) => {
    const refundTag = trx.refunded ? " <i>[REFUNDED]</i>" : "";
    return (
      `${index + 1}. <code>${trx.id}</code> — @${escapeHTML(trx.username || "-")} (<code>${trx.userId || "-"}</code>)\n` +
      `   📱 ${escapeHTML(trx.productName || trx.negara || "-")} | 💰 <b>${rupiah(trx.harga)}</b>${refundTag}\n` +
      `   🕐 <code>${new Date(trx.date).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</code>`
    );
  });

  const text = `<blockquote>🧾 <b>${headerTitle}</b>\n━━━━━━━━━━━━━━━━\n${lines.join("\n\n")}</blockquote>`;
  try {
    await ctx.replyWithHTML(text);
  } catch {
    // If still exceeds length, fallback to shorter list
    const shortText = `<blockquote>🧾 <b>${headerTitle}</b>\n━━━━━━━━━━━━━━━━\n${lines.slice(0, 8).join("\n\n")}</blockquote>`;
    await ctx.replyWithHTML(shortText).catch(() => {});
  }
});

bot.command("setprofit", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ownerArgs(ctx);
  const uid = ctx.from.id;

  if (args.length >= 3) {
    const [target, mode, value] = args;
    const prov = db.normalizeProvider(target) || target;
    if (db.setProfit(prov, mode, value)) {
      const p = db.getProfit(prov);
      const display = p.mode === "percent" ? `${p.value}%` : rupiah(p.value);
      return ctx.replyWithHTML(`<blockquote>✅ Profit default <b>${target}</b> berhasil disimpan: <b>${display}</b> (${p.mode}).</blockquote>`);
    }
    return ctx.reply("❌ Gagal menyimpan profit. Format: /setprofit <server> <flat|persen> <nilai>");
  } else if (args.length === 2) {
    const [arg0, arg1] = args;
    const targetProv = db.normalizeProvider(arg0) || (arg0.toLowerCase() === "all" ? "all" : null);
    if (targetProv) {
      const parsed = parseProfitInput(arg1);
      if (parsed && db.setProfit(targetProv, parsed.mode, parsed.value)) {
        const display = parsed.mode === "percent" ? `${parsed.value}%` : rupiah(parsed.value);
        return ctx.replyWithHTML(`<blockquote>✅ Profit default <b>${arg0}</b> berhasil disimpan: <b>${display}</b> (${parsed.mode}).</blockquote>`);
      }
    }
    if (db.setProfit("all", arg0, arg1)) {
      const norm = (arg0.toLowerCase().includes("persen") || arg0.toLowerCase().includes("percent") || arg0 === "%") ? `${arg1}%` : rupiah(arg1);
      return ctx.replyWithHTML(`<blockquote>✅ Profit default semua server berhasil disimpan: <b>${norm}</b>.</blockquote>`);
    }
    return ctx.reply("❌ Gagal menyimpan profit. Format: /setprofit <server> <flat|persen> <nilai> atau /setprofit <server> <nilai>");
  } else if (args.length === 1) {
    const parsed = parseProfitInput(args[0]);
    if (parsed && db.setProfit("all", parsed.mode, parsed.value)) {
      const display = parsed.mode === "percent" ? `${parsed.value}%` : rupiah(parsed.value);
      return ctx.replyWithHTML(`<blockquote>✅ Profit default semua server berhasil disimpan: <b>${display}</b> (${parsed.mode}).</blockquote>`);
    }
  }

  const wahubProfit = db.getProfit("wahub");
  const euProfit = db.getProfit("engineunicorn");
  const fastbitProfit = db.getProfit("fastbit");
  const roProfit = db.getProfit("rumahotp");

  return ctx.replyWithHTML(
    `<blockquote>⚙️ <b>PENGATURAN PROFIT (MARKUP)</b>
━━━━━━━━━━━━━━━━
💰 <b>Profit Default Saat Ini:</b>
🟢 Server 1⃣ (WA) : <b>${wahubProfit.mode === "percent" ? `${wahubProfit.value}%` : rupiah(wahubProfit.value)}</b> (${wahubProfit.mode})
🟡 Server 2⃣ (WA) : <b>${euProfit.mode === "percent" ? `${euProfit.value}%` : rupiah(euProfit.value)}</b> (${euProfit.mode})
✉️ Server 1⃣ (SMS): <b>${fastbitProfit.mode === "percent" ? `${fastbitProfit.value}%` : rupiah(fastbitProfit.value)}</b> (${fastbitProfit.mode})
✉️ Server 2⃣ (FlashCall): <b>${roProfit.mode === "percent" ? `${roProfit.value}%` : rupiah(roProfit.value)}</b> (${roProfit.mode})
━━━━━━━━━━━━━━━━
Pilih server yang ingin diatur profitnya:

<i>Atau gunakan perintah cepat (bisa flat/persen):</i>
<code>/setprofit sms1 flat 500</code>
<code>/setprofit sms1 persen 15</code>
<code>/setprofit sms2 flat 500</code>
<code>/setprofit all flat 500</code>
<code>/setprofit all persen 10</code></blockquote>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🟢 Server 1⃣ (WA)", `profit_provider_wahub_${uid}`),
        Markup.button.callback("🟡 Server 2⃣ (WA)", `profit_provider_engineunicorn_${uid}`),
      ],
      [
        Markup.button.callback("✉️ Server 1⃣ (SMS)", `profit_provider_fastbit_${uid}`),
        Markup.button.callback("✉️ Server 2⃣ (FlashCall)", `profit_provider_rumahotp_${uid}`),
      ],
      [
        Markup.button.callback("🌐 Atur Default Semua Server", `profit_set_default_all_${uid}`),
      ],
    ])
  );
});

bot.action(/^profit_provider_(wahub|engineunicorn|fastbit|herosms|rumahotp)_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const provider = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  await ctx.answerCbQuery();
  const current = db.getProfit(provider);
  const display = current.mode === "percent" ? `${current.value}%` : rupiah(current.value);
  const label = provider === "wahub"
    ? "Server 1⃣ (WA)"
    : provider === "engineunicorn"
    ? "Server 2⃣ (WA)"
    : provider === "fastbit"
    ? "Server 1⃣ (SMS)"
    : provider === "herosms"
    ? "Server 1⃣ (SMS)"
    : "Server 2⃣ (FlashCall + SMS)";

  return ctx.replyWithHTML(
    `<blockquote>⚙️ <b>SETTING PROFIT — ${label}</b>
━━━━━━━━━━━━━━━━
💰 Profit Default Saat Ini: <b>${display}</b> (${current.mode})

Pilih jenis pengaturan profit:</blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💵 Atur Profit Default Server", `profit_set_default_${provider}_${uid}`)],
      [Markup.button.callback("🔧 Atur Profit Per Layanan", `profit_services_${provider}_${uid}`)],
      [Markup.button.callback("🔙 Kembali", `profit_back_main_${uid}`)],
    ])
  );
});

bot.action(/^profit_set_default_(wahub|engineunicorn|fastbit|herosms|rumahotp|all)_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const provider = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  await ctx.answerCbQuery();
  const label = provider === "all"
    ? "Semua Server"
    : provider === "wahub"
    ? "Server 1⃣ (WA)"
    : provider === "engineunicorn"
    ? "Server 2⃣ (WA)"
    : provider === "fastbit"
    ? "Server 1⃣ (SMS)"
    : provider === "herosms"
    ? "Server 1⃣ (SMS)"
    : "Server 2⃣ (FlashCall + SMS)";

  sessions[uid] = {
    step: "owner_default_profit_value",
    profitTargetProvider: provider,
  };

  return ctx.replyWithHTML(
    `<blockquote>💰 <b>ATUR PROFIT DEFAULT — ${label}</b>
━━━━━━━━━━━━━━━━
Kirim nominal markup untuk server ini:
• <b>Flat:</b> kirim <code>500</code> atau <code>flat 500</code>
• <b>Persen:</b> kirim <code>10%</code> atau <code>persen 10</code>

<i>Ketik pesan langsung di chat ini untuk menyimpan.</i></blockquote>`
  );
});

bot.action(/^profit_back_main_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  const uid = parseInt(ctx.match[1]);
  const wahubProfit = db.getProfit("wahub");
  const euProfit = db.getProfit("engineunicorn");
  const fastbitProfit = db.getProfit("fastbit");
  const roProfit = db.getProfit("rumahotp");

  return ctx.replyWithHTML(
    `<blockquote>⚙️ <b>PENGATURAN PROFIT (MARKUP)</b>
━━━━━━━━━━━━━━━━
💰 <b>Profit Default Saat Ini:</b>
🟢 Server 1⃣ (WA) : <b>${wahubProfit.mode === "percent" ? `${wahubProfit.value}%` : rupiah(wahubProfit.value)}</b> (${wahubProfit.mode})
🟡 Server 2⃣ (WA) : <b>${euProfit.mode === "percent" ? `${euProfit.value}%` : rupiah(euProfit.value)}</b> (${euProfit.mode})
✉️ Server 1⃣ (SMS): <b>${fastbitProfit.mode === "percent" ? `${fastbitProfit.value}%` : rupiah(fastbitProfit.value)}</b> (${fastbitProfit.mode})
✉️ Server 2⃣ (FlashCall): <b>${roProfit.mode === "percent" ? `${roProfit.value}%` : rupiah(roProfit.value)}</b> (${roProfit.mode})
━━━━━━━━━━━━━━━━
Pilih server yang ingin diatur profitnya:

<i>Atau gunakan perintah cepat (bisa flat/persen):</i>
<code>/setprofit sms1 flat 500</code>
<code>/setprofit sms1 persen 15</code>
<code>/setprofit sms2 flat 500</code>
<code>/setprofit all flat 500</code>
<code>/setprofit all persen 10</code></blockquote>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🟢 Server 1⃣ (WA)", `profit_provider_wahub_${uid}`),
        Markup.button.callback("🟡 Server 2⃣ (WA)", `profit_provider_engineunicorn_${uid}`),
      ],
      [
        Markup.button.callback("✉️ Server 1⃣ (SMS)", `profit_provider_fastbit_${uid}`),
        Markup.button.callback("✉️ Server 2⃣ (FlashCall)", `profit_provider_rumahotp_${uid}`),
      ],
      [
        Markup.button.callback("🌐 Atur Default Semua Server", `profit_set_default_all_${uid}`),
      ],
    ])
  );
});

bot.action(/^profit_services_(wahub|engineunicorn|fastbit|herosms|rumahotp)_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const provider = ctx.match[1];
  const uid = parseInt(ctx.match[2]);
  await ctx.answerCbQuery("⏳ Memuat layanan...");

  let services = [];
  if (provider === "wahub") services = await wahub.getServices();
  else if (provider === "engineunicorn") services = await engineunicorn.getServices();
  else if (provider === "fastbit") services = await fastbit.getServices();
  else if (provider === "herosms") services = await herosms.getServices();
  else if (provider === "rumahotp") services = await herosms.getServices();

  if (!services.length) return ctx.reply("❌ Layanan server ini tidak tersedia dari API.");
  sessions[uid] = {
    step: "owner_profit_service",
    profitProvider: provider,
    profitServices: services,
    profitServicePage: 1,
  };
  return showOwnerProfitServices(ctx, uid);
});

async function showOwnerProfitServices(ctx, uid, editMsgId = null) {
  const sess = sessions[uid];
  const services = sess?.profitServices || [];
  const provider = sess?.profitProvider;
  const totalPage = Math.max(1, Math.ceil(services.length / 30));
  const page = Math.min(Math.max(sess.profitServicePage || 1, 1), totalPage);
  sess.profitServicePage = page;
  const start = (page - 1) * 30;
  const pageItems = services.slice(start, start + 30);
  const buttons = threeColumnButtons(pageItems, (service, index) => {
    const stockInfo = service.stock !== undefined ? ` (${formatStock(service.stock)})` : "";
    return Markup.button.callback(
      `${shortButtonText(service.name, 10)}${stockInfo}`,
      `profit_service_${provider}_${start + index}_${uid}`
    );
  });
  addPageButtons(
    buttons,
    page,
    totalPage,
    `profit_svc_pg_${uid}_${page - 1}`,
    `profit_svc_pg_${uid}_${page + 1}`,
    `profit_provider_${provider}_${uid}`
  );

  const providerLabelMap = {
    wahub: "Server 1⃣ (WA)",
    engineunicorn: "Server 2⃣ (WA)",
    fastbit: "Server 1⃣ (SMS)",
    herosms: "Server 1⃣ (SMS)",
    rumahotp: "Server 2⃣ (FlashCall + SMS)",
  };
  const label = providerLabelMap[provider] || provider;

  const teks = `<blockquote>🔧 <b>ATUR PROFIT PER LAYANAN</b>
Server: <b>${escapeHTML(label)}</b>
━━━━━━━━━━━━━━━━
Pilih layanan yang ingin diatur profit spesifiknya:
Hal ${page}/${totalPage}</blockquote>`;
  const options = { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(buttons).reply_markup };
  if (editMsgId) return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, teks, options).catch(() => ctx.replyWithHTML(teks, options));
  return ctx.replyWithHTML(teks, options);
}

bot.action(/^profit_svc_pg_(\d+)_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return;
  const sess = sessions[uid];
  if (!sess || sess.step !== "owner_profit_service") return ctx.answerCbQuery("❌ Sesi habis.", { show_alert: true });
  sess.profitServicePage = parseInt(ctx.match[2]);
  await showOwnerProfitServices(ctx, uid, ctx.callbackQuery?.message?.message_id);
});

bot.action(/^profit_service_(wahub|engineunicorn|fastbit|herosms|rumahotp)_(\d+)_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const provider = ctx.match[1];
  const index = parseInt(ctx.match[2]);
  const uid = parseInt(ctx.match[3]);
  const sess = sessions[uid];
  const service = sess?.profitServices?.[index];
  if (!sess || sess.step !== "owner_profit_service" || !service) {
    return ctx.answerCbQuery("❌ Sesi setting profit habis.", { show_alert: true });
  }
  sessions[uid] = {
    step: "owner_profit_value",
    profitProvider: provider,
    profitServiceId: String(service.id),
    profitServiceName: service.name,
  };
  await ctx.answerCbQuery();
  const providerLabelMap = {
    wahub: "Server 1⃣ (WA)",
    engineunicorn: "Server 2⃣ (WA)",
    fastbit: "Server 1⃣ (SMS)",
    herosms: "Server 1⃣ (SMS)",
    rumahotp: "Server 2⃣ (FlashCall + SMS)",
  };
  const label = providerLabelMap[provider] || provider;

  return ctx.replyWithHTML(
    `<blockquote>💰 <b>MASUKKAN PROFIT LAYANAN</b>\n` +
    `Server: <b>${escapeHTML(label)}</b>\n` +
    `Layanan: <b>${escapeHTML(service.name)}</b>\n━━━━━━━━━━━━━━━━\n` +
    `Kirim nominal markup (flat atau persen):\n` +
    `• Contoh flat: <code>500</code>\n` +
    `• Contoh persen: <code>10%</code></blockquote>`
  );
});

bot.command("setfee", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const [mode, value] = ownerArgs(ctx);
  if (!mode || value === undefined || !db.setPaymentFee(mode, value)) {
    return ctx.reply("❌ Format: /setfee persen 0.5 atau /setfee flat 1000");
  }
  const fee = db.getPaymentFee();
  await ctx.replyWithHTML(
    `<blockquote>✅ Fee QRIS disimpan.\nMode: <b>${fee.mode === "percent" ? "persen" : "flat"}</b>\n` +
    `Nilai: <b>${fee.mode === "percent" ? `${fee.value}%` : rupiah(fee.value)}</b></blockquote>`
  );
});

bot.command("maintenance", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const requested = ownerArgs(ctx)[0]?.toLowerCase();
  if (["on", "aktif", "aktifkan"].includes(requested)) {
    db.setMaintenance(true);
    return ctx.replyWithHTML("<blockquote>⚠️ Maintenance <b>AKTIF</b>. User tidak dapat menggunakan bot.</blockquote>");
  }
  if (["off", "nonaktif", "matikan"].includes(requested)) {
    db.setMaintenance(false);
    return ctx.replyWithHTML("<blockquote>✅ Maintenance <b>NONAKTIF</b>. Bot kembali melayani user.</blockquote>");
  }
  await ctx.replyWithHTML(
    `<blockquote>🛠️ <b>MAINTENANCE</b>\nStatus saat ini: <b>${db.getMaintenance() ? "AKTIF" : "NONAKTIF"}</b>\nPilih aksi:</blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚠️ Aktifkan", "maintenance_on"), Markup.button.callback("✅ Nonaktifkan", "maintenance_off")],
    ])
  );
});

bot.action(/^maintenance_(on|off)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const enabled = ctx.match[1] === "on";
  db.setMaintenance(enabled);
  await ctx.answerCbQuery("Status maintenance diperbarui.");
  await ctx.editMessageText(
    `<blockquote>✅ Maintenance sekarang <b>${enabled ? "AKTIF" : "NONAKTIF"}</b>.</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
});

// ── /manualdeposit — On/Off pembayaran manual ─────────────
bot.command(["manualdeposit", "setmanual", "manualdepo"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const requested = ownerArgs(ctx)[0]?.toLowerCase();
  if (["on", "aktif", "aktifkan", "buka", "true"].includes(requested)) {
    db.setManualDeposit(true);
    return ctx.replyWithHTML("<blockquote>✅ Pembayaran manual <b>DIAKTIFKAN</b>. User dapat memilih deposit manual.</blockquote>");
  }
  if (["off", "nonaktif", "matikan", "tutup", "false"].includes(requested)) {
    db.setManualDeposit(false);
    return ctx.replyWithHTML("<blockquote>🔴 Pembayaran manual <b>DINONAKTIFKAN</b>. Menu deposit manual disembunyikan dari user.</blockquote>");
  }
  const isEnabled = db.getManualDeposit();
  await ctx.replyWithHTML(
    `<blockquote>📤 <b>PENGATURAN DEPOSIT MANUAL</b>\nStatus saat ini: <b>${isEnabled ? "🟢 AKTIF" : "🔴 NONAKTIF"}</b>\nPilih aksi:</blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🟢 Aktifkan", "manual_depo_on"), Markup.button.callback("🔴 Nonaktifkan", "manual_depo_off")],
    ])
  );
});

bot.action(/^manual_depo_(on|off)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const enabled = ctx.match[1] === "on";
  db.setManualDeposit(enabled);
  await ctx.answerCbQuery("Status deposit manual diperbarui.");
  await ctx.editMessageText(
    `<blockquote>📤 Deposit manual sekarang <b>${enabled ? "🟢 AKTIF" : "🔴 NONAKTIF"}</b>.</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
});

function syncRealtimeChannelToMandatoryJoin() {
  if (!config.CHANNEL_NOTIF_REALTIME) return;
  const raw = String(config.CHANNEL_NOTIF_REALTIME).trim();
  const uname = raw.startsWith("@") ? raw : (raw.startsWith("-100") ? "" : `@${raw}`);
  const link = uname ? `https://t.me/${uname.replace(/^@/, "")}` : (raw.startsWith("http") ? raw : "");
  const settings = db.getMandatoryJoinSettings();
  const exists = settings.chats.some(item =>
    (uname && String(item.username).toLowerCase() === uname.toLowerCase()) ||
    (raw.startsWith("-100") && String(item.id) === raw) ||
    (link && String(item.link).toLowerCase() === link.toLowerCase())
  );
  if (!exists) {
    db.addMandatoryJoin({
      id: raw.startsWith("-100") ? raw : "",
      title: "CALABAY Notif Realtime",
      link: link || `https://t.me/${raw.replace(/^@/, "")}`,
      username: uname || raw,
    });
  }
}

function mandatoryJoinStatusText() {
  const settings = getEffectiveMandatoryJoinSettings();
  if (!settings.chats.length) return "Belum ada channel/grup yang ditambahkan.";
  return settings.chats.map((chat, index) =>
    `${index + 1}. <b>${escapeHTML(chat.title || chat.username || "Channel/Grup")}</b>\n` +
    `   ${escapeHTML(chat.link || chat.id || "-")}`
  ).join("\n");
}

bot.command("wajibjoin", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const requested = ownerArgs(ctx)[0]?.toLowerCase();
  if (["on", "aktif", "aktifkan"].includes(requested)) {
    db.setMandatoryJoinEnabled(true);
    return ctx.replyWithHTML("<blockquote>🔐 Wajib join <b>AKTIF</b>.</blockquote>");
  }
  if (["off", "nonaktif", "matikan"].includes(requested)) {
    db.setMandatoryJoinEnabled(false);
    return ctx.replyWithHTML("<blockquote>🔓 Wajib join <b>NONAKTIF</b>.</blockquote>");
  }
  const settings = getEffectiveMandatoryJoinSettings();
  await ctx.replyWithHTML(
    `<blockquote>🔐 <b>PENGATURAN WAJIB JOIN</b>
Status: <b>${settings.enabled ? "AKTIF" : "NONAKTIF"}</b>

${mandatoryJoinStatusText()}</blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Aktifkan", "mandatory_join_on"), Markup.button.callback("⛔ Nonaktifkan", "mandatory_join_off")],
    ])
  );
});

bot.action(/^mandatory_join_(on|off)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const enabled = ctx.match[1] === "on";
  db.setMandatoryJoinEnabled(enabled);
  await ctx.answerCbQuery("Status wajib join diperbarui.");
  await ctx.editMessageText(
    `<blockquote>🔐 Wajib join sekarang <b>${enabled ? "AKTIF" : "NONAKTIF"}</b>.</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
});

bot.command(["setchorder", "setchlaporan"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ownerArgs(ctx);
  if (!args.length) {
    return ctx.replyWithHTML(`<blockquote>ℹ️ Channel laporan order saat ini: <b>${escapeHTML(config.CHANNEL_NOTIF_ORDER || "Belum diatur")}</b>\n\nCara ganti:\n<code>/setchorder @username_channel</code> atau ID channel <code>-100xxx</code></blockquote>`);
  }
  const target = args[0].trim();
  config.CHANNEL_NOTIF_ORDER = target;
  return ctx.replyWithHTML(`<blockquote>✅ Channel laporan order OTP berhasil diatur ke: <b>${escapeHTML(target)}</b>\n\nPastikan bot sudah dijadikan admin di channel tersebut! Gunakan <code>/testchorder</code> untuk uji coba kirim notifikasi.</blockquote>`);
});

bot.command(["testchorder", "testchlaporan"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const targetChannel = getOrderReportChannel();
  if (!targetChannel) {
    return ctx.replyWithHTML("<blockquote>❌ Channel laporan order belum diatur. Gunakan <code>/setchorder @channel_kamu</code></blockquote>");
  }

  await ctx.replyWithHTML(`<blockquote>⏳ Mengirim pesan uji coba laporan order ke <b>${escapeHTML(targetChannel)}</b>...</blockquote>`);

  try {
    await sendChannelOrderReportNotification({
      type: "WHATSAPP",
      username: ctx.from.username || ctx.from.first_name || "kayy",
      userId: ctx.from.id,
      serviceName: "Dana",
      phone: "6283865381009",
      harga: 1100,
      modal: 700,
      otp: "839102",
      serverName: "Server 1 (WhatsApp)",
    });
    return ctx.replyWithHTML(`<blockquote>✅ Pesan uji coba berhasil terkirim ke <b>${escapeHTML(targetChannel)}</b>! Silakan cek channel Anda.</blockquote>`);
  } catch (err) {
    return ctx.replyWithHTML(`<blockquote>❌ Gagal mengirim: ${escapeHTML(err.message)}\n\nPastikan bot sudah dijadikan <b>Admin</b> di channel tersebut dengan izin Kirim Pesan.</blockquote>`);
  }
});

bot.command("addjoin", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ownerArgs(ctx);
  const first = args.shift();
  const explicitLink = first && /^-100\d+$/.test(first) && args[0]?.startsWith("http")
    ? args.shift()
    : "";
  const target = joinTargetFromInput(first, explicitLink);
  if (!target) {
    return ctx.replyWithHTML(
      "<blockquote>❌ Format:\n/addjoin @username\n/addjoin https://t.me/username\n/addjoin -1001234567890 https://t.me/+invite</blockquote>"
    );
  }
  if (!target.lookup && !target.id) {
    return ctx.replyWithHTML(
      "<blockquote>❌ Link invite privat belum cukup untuk verifikasi. Gunakan ID chat dan link:\n<code>/addjoin -1001234567890 https://t.me/+invite</code></blockquote>"
    );
  }

  let chat;
  try {
    chat = await ctx.telegram.getChat(target.lookup || target.id);
  } catch (error) {
    return ctx.replyWithHTML(
      `<blockquote>❌ Chat tidak ditemukan atau bot belum bisa mengaksesnya.\n` +
      `Pastikan username/link benar, lalu jadikan bot admin terlebih dahulu.\n\n` +
      `Detail: ${escapeHTML(error.message)}</blockquote>`
    );
  }

  const chatData = {
    id: String(chat.id || target.id),
    title: chat.title || chat.username || target.link,
    link: target.link || (chat.username ? `https://t.me/${chat.username}` : ""),
    username: chat.username ? `@${chat.username.replace(/^@/, "")}` : target.username,
  };
  if (!chatData.id) return ctx.reply("❌ ID chat tidak tersedia.");
  if (!db.addMandatoryJoin(chatData)) {
    return ctx.reply("❌ Channel/grup tersebut sudah ada di daftar wajib join.");
  }

  let adminWarning = "";
  try {
    const botInfo = ctx.botInfo || await bot.telegram.getMe();
    const botMember = await ctx.telegram.getChatMember(chatData.id, botInfo.id);
    if (!["creator", "administrator"].includes(botMember.status)) {
      adminWarning = "\n\n⚠️ <b>PERHATIAN:</b> Bot belum terdeteksi sebagai admin. Jadikan bot admin agar tombol verifikasi dapat bekerja.";
    }
  } catch {
    adminWarning = "\n\n⚠️ <b>PERHATIAN:</b> Pastikan bot sudah menjadi admin di chat tersebut agar tombol verifikasi dapat bekerja.";
  }

  await ctx.replyWithHTML(
    `<blockquote>✅ Channel/grup berhasil ditambahkan ke wajib join.
📢 <b>${escapeHTML(chatData.title)}</b>
🔗 ${escapeHTML(chatData.link || chatData.id)}

⚠️ Ingat: bot harus dijadikan <b>admin</b> terlebih dahulu.${adminWarning}</blockquote>`
  );
});

bot.command("listjoin", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const settings = getEffectiveMandatoryJoinSettings();
  await ctx.replyWithHTML(
    `<blockquote>🔐 <b>DAFTAR WAJIB JOIN</b>
Status fitur: <b>${settings.enabled ? "AKTIF" : "NONAKTIF"}</b>

${mandatoryJoinStatusText()}</blockquote>`
  );
});

bot.command("deljoin", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const identifier = ownerArgs(ctx)[0];
  if (!identifier) return ctx.reply("❌ Format: /deljoin <nomor daftar|link|chatId>");
  const removed = db.removeMandatoryJoin(identifier);
  if (!removed) return ctx.reply("❌ Data wajib join tidak ditemukan.");
  await ctx.replyWithHTML(
    `<blockquote>✅ Wajib join dihapus:
<b>${escapeHTML(removed.title || removed.link || removed.id)}</b></blockquote>`
  );
});

bot.command("setreferral", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const reward = ownerArgs(ctx)[0];
  if (reward === undefined || !db.setReferralReward(reward)) {
    return ctx.reply("❌ Format: /setreferral <bonus coin>\nContoh: /setreferral 1000");
  }
  await ctx.replyWithHTML(
    `<blockquote>✅ Bonus referral disimpan: <b>${rupiah(db.getReferralSettings().reward)}</b> per user baru yang berhasil join.</blockquote>`
  );
});

bot.command("referralstatus", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const settings = db.getReferralSettings();
  await ctx.replyWithHTML(
    `<blockquote>🎁 <b>STATUS REFERRAL</b>
Status: <b>${settings.enabled ? "AKTIF" : "NONAKTIF"}</b>
Bonus: <b>${rupiah(settings.reward)}</b> per referral berhasil</blockquote>`
  );
});

bot.command("ownermenu", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  await ctx.replyWithHTML(
`<blockquote>👑 <b>OWNER MENU</b>
━━━━━━━━━━━━━━━━
<b>SALDO & USER</b>
/addsaldo [userId/@username] [jumlah]
/delsaldo [userId/@username] [jumlah]
/listuser
/listtransaksi [jumlah]

<b>HARGA & PAYMENT</b>
/setprofit — Setting profit per layanan dari API
/setfee [persen|flat] [nilai]
/manualdeposit [on|off] — Atur ON/OFF deposit manual
/setqris [url]

<b>RESELLER</b>
/resellerstatus — Cek status & statistik reseller
/setreseller [on|off] — Aktif/nonaktifkan fitur reseller
/setresellerthreshold [jumlah] — Target trx bulanan (default 100)
/setresellerdiscount [flat|percent] [nilai] — Diskon harga
/setresellermonthly [on|off] — Auto-reset bulanan tiap tgl 1
/addreseller [userId/@username] — Beri role reseller manual
/delreseller [userId/@username] — Cabut role reseller manual
/listreseller — Daftar user reseller
/resetreseller — Reset trx bulanan reseller sekarang

<b>BOT</b>
/maintenance
/wajibjoin [on|off] — Atur wajib join
/addjoin [@username|link] — Tambah channel/grup wajib join
/listjoin — Daftar channel/grup wajib join
/deljoin [nomor|link] — Hapus channel/grup wajib join
/referral [on|off] — Aktif/nonaktif referral
/setreferral [bonus] — Atur bonus referral
/setkomisi [persen] — Atur komisi deposit referral
/referralstatus — Status referral
/broadcasttopreferral — Broadcast top referral ke channel
/broadcast (reply pesan)
/backup
/stats
/ceksaldo</blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🛠️ Maintenance", "owner_maintenance_menu")],
      [Markup.button.callback(
        db.getManualDeposit() ? "📤 Deposit Manual: 🟢 ON" : "📤 Deposit Manual: 🔴 OFF",
        "toggle_manual_deposit_inline"
      )],
    ])
  );
});

bot.action("toggle_manual_deposit_inline", async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const newState = !db.getManualDeposit();
  db.setManualDeposit(newState);
  await ctx.answerCbQuery(`Deposit manual: ${newState ? "🟢 AKTIF" : "🔴 NONAKTIF"}`);
  await ctx.editMessageReplyMarkup(
    Markup.inlineKeyboard([
      [Markup.button.callback("🛠️ Maintenance", "owner_maintenance_menu")],
      [Markup.button.callback(
        newState ? "📤 Deposit Manual: 🟢 ON" : "📤 Deposit Manual: 🔴 OFF",
        "toggle_manual_deposit_inline"
      )],
    ]).reply_markup
  ).catch(() => {});
});

bot.action("owner_maintenance_menu", async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `<blockquote>🛠️ Status maintenance: <b>${db.getMaintenance() ? "AKTIF" : "NONAKTIF"}</b></blockquote>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚠️ Aktifkan", "maintenance_on"), Markup.button.callback("✅ Nonaktifkan", "maintenance_off")],
    ])
  );
});

// /addcoin <userId> <jumlah>
bot.command("addcoin", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args  = ctx.message.text.split(/\s+/).slice(1);
  const uid   = args[0];
  const jml   = parseInt(args[1]);
  if (!uid || isNaN(jml)) return ctx.reply("❌ Format: /addcoin 5907728 1000");

  const user = db.getUser(uid);
  if (!user) return ctx.reply(`❌ User ${uid} belum terdaftar di bot.`);

  const newCoin = db.addCoin(uid, jml);
  ctx.replyWithHTML(
    `<blockquote>✅ Coin ditambahkan!\n👤 User: <code>${uid}</code>\n🪙 Ditambah: <b>${rupiah(jml)}</b>\n💰 Total coin: <b>${rupiah(newCoin)}</b></blockquote>`
  );
  bot.telegram.sendMessage(uid,
    `<blockquote>🎁 <b>Coin ditambahkan oleh admin!</b>\n🪙 Ditambah: <b>${rupiah(jml)}</b>\n💰 Total coin: <b>${rupiah(newCoin)}</b></blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
});

bot.command("setqris", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const url = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
  if (!url) return ctx.reply("❌ Format: /setqris https://...");
  config.QRIS_URL = url;
  ctx.replyWithHTML(`<blockquote>✅ QRIS URL diupdate.</blockquote>`);
});

// ── /server /setserver — Toggle status Server 1 dan Server 2 ────
function sendServerStatusPanel(ctx, editMsgId = null) {
  const status = db.getServerStatus();
  const s1 = status.server1;
  const s2 = status.server2;
  const sms1 = status.smsServer1;
  const sms2 = status.smsServer2;
  const uid = ctx.from.id;

  const text = `<blockquote>⚙️ <b>PENGATURAN STATUS SERVER NOKOS</b>
━━━━━━━━━━━━━━━━
Status Server Saat Ini:
🟢 <b>Server 1⃣ (WA)</b> : ${s1 ? "🟢 <b>AKTIF</b>" : "🔴 <i>NONAKTIF</i>"}
🟡 <b>Server 2⃣ (WA)</b> : ${s2 ? "🟡 <b>AKTIF</b>" : "🔴 <i>NONAKTIF</i>"}
✉️ <b>Server 1⃣ (SMS)</b>: ${sms1 ? "🟢 <b>AKTIF</b>" : "🔴 <i>NONAKTIF</i>"}
✉️ <b>Server 2⃣ (FlashCall + SMS)</b>: ${sms2 ? "🟡 <b>AKTIF</b>" : "🔴 <i>NONAKTIF</i>"}
━━━━━━━━━━━━━━━━
💡 Klik tombol di bawah untuk mengubah status server, atau gunakan command:
• <code>/server 1 on</code> / <code>/server 1 off</code> (WA Server 1)
• <code>/server 2 on</code> / <code>/server 2 off</code> (WA Server 2)
• <code>/server sms1 on</code> / <code>/server sms1 off</code> (SMS Server 1)
• <code>/server sms2 on</code> / <code>/server sms2 off</code> (SMS Server 2 - FlashCall)</blockquote>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${s1 ? "🟢" : "🔴"} Server 1⃣ (WA): ${s1 ? "AKTIF" : "NONAKTIF"}`,
        `toggle_server_1_${uid}`
      ),
    ],
    [
      Markup.button.callback(
        `${s2 ? "🟡" : "🔴"} Server 2⃣ (WA): ${s2 ? "AKTIF" : "NONAKTIF"}`,
        `toggle_server_2_${uid}`
      ),
    ],
    [
      Markup.button.callback(
        `${sms1 ? "🟢" : "🔴"} Server 1⃣ (SMS): ${sms1 ? "AKTIF" : "NONAKTIF"}`,
        `toggle_server_sms1_${uid}`
      ),
    ],
    [
      Markup.button.callback(
        `${sms2 ? "🟡" : "🔴"} Server 2⃣ (FlashCall): ${sms2 ? "AKTIF" : "NONAKTIF"}`,
        `toggle_server_sms2_${uid}`
      ),
    ],
    [
      Markup.button.callback("🔄 Refresh Status", `refresh_server_status_${uid}`),
    ],
  ]);

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup,
    }).catch(() => ctx.replyWithHTML(text, keyboard));
  }
  return ctx.replyWithHTML(text, keyboard);
}

bot.command(["server", "setserver", "servers"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const serverKey = args[0]?.toLowerCase();
  const stateArg = args[1]?.toLowerCase();

  if (serverKey && ["1", "2", "sms1", "sms2"].includes(serverKey) && stateArg && ["on", "off", "aktif", "nonaktif", "true", "false", "buka", "tutup"].includes(stateArg)) {
    const isEnable = ["on", "aktif", "true", "buka"].includes(stateArg);
    db.setServerStatus(serverKey, isEnable);
    let serverLabel = "Server";
    if (serverKey === "1") serverLabel = "Server 1⃣ (WA)";
    else if (serverKey === "2") serverLabel = "Server 2⃣ (WA)";
    else if (serverKey === "sms1") serverLabel = "Server 1⃣ (SMS)";
    else if (serverKey === "sms2") serverLabel = "Server 2⃣ (FlashCall + SMS)";
    return ctx.replyWithHTML(
      `<blockquote>${isEnable ? "✅" : "🔴"} <b>${serverLabel}</b> berhasil <b>${isEnable ? "DIAKTIFKAN" : "DINONAKTIFKAN"}</b>.</blockquote>`
    );
  }

  return sendServerStatusPanel(ctx);
});

bot.action(/^toggle_server_(1|2|sms1|sms2)_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  const serverKey = String(ctx.match[1]);
  const currentStatus = db.getServerStatus();
  let newStatus = false;
  let serverName = "";

  if (serverKey === "1") {
    newStatus = !currentStatus.server1;
    serverName = "Server 1⃣ (WA)";
  } else if (serverKey === "2") {
    newStatus = !currentStatus.server2;
    serverName = "Server 2⃣ (WA)";
  } else if (serverKey === "sms1") {
    newStatus = !currentStatus.smsServer1;
    serverName = "Server 1⃣ (SMS)";
  } else if (serverKey === "sms2") {
    newStatus = !currentStatus.smsServer2;
    serverName = "Server 2⃣ (FlashCall + SMS)";
  }

  db.setServerStatus(serverKey, newStatus);
  await ctx.answerCbQuery(`${serverName} sekarang: ${newStatus ? "AKTIF" : "NONAKTIF"}`);
  return sendServerStatusPanel(ctx, ctx.callbackQuery?.message?.message_id);
});

bot.action(/^refresh_server_status_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCbQuery("❌ Khusus owner.", { show_alert: true });
  await ctx.answerCbQuery("Status diperbarui.");
  return sendServerStatusPanel(ctx, ctx.callbackQuery?.message?.message_id);
});

bot.command("ceksaldo", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const loadMsg = await ctx.replyWithHTML("<blockquote>🔍 <i>Mengecek saldo server...</i></blockquote>");
  const [b1, b2, bSms1, bSms2] = await Promise.all([
    wahub.getBalance().catch(() => null),
    engineunicorn.getBalance().catch(() => null),
    fastbit.getBalance().catch(() => null),
    herosms.getBalance().catch(() => null),
  ]);

  const b1Text = b1
    ? `💰 Saldo: <b>${rupiah(b1.balance)}</b>\n🔒 Terpakai: <b>${rupiah(b1.reserved)}</b>\n✅ Tersedia: <b>${rupiah(b1.available)}</b>`
    : `❌ Gagal: ${escapeHTML(wahub.getLastError() || "tidak tersedia")}`;

  const b2Text = b2
    ? `💰 Saldo: <b>${rupiah(b2.balance)}</b> ${b2.currency || "IDR"}`
    : `❌ Gagal: ${escapeHTML(engineunicorn.getLastError() || "tidak tersedia")}`;

  const bSms1Text = bSms1
    ? `💰 Saldo: <b>${bSms1.formatted || rupiah(bSms1.balance)}</b>`
    : `❌ Gagal: ${escapeHTML(fastbit.getLastError() || "tidak tersedia")}`;

  const bSms2Text = bSms2
    ? `💰 Saldo: <b>${usd(bSms2.balance)}</b> (~${rupiah(bSms2.balanceIdr)})\n⚡ Metode: <b>FlashCall + SMS</b>`
    : `❌ Gagal: ${escapeHTML(herosms.getLastError() || "tidak tersedia")}`;

  const text = `<blockquote>💰 <b>SALDO PENYEDIA NOKOS</b>
━━━━━━━━━━━━━━
🟢 <b>Server 1⃣ (WA):</b>
${b1Text}

🟡 <b>Server 2⃣ (WA):</b>
${b2Text}

✉️ <b>Server 1⃣ (SMS):</b>
${bSms1Text}

✉️ <b>Server 2⃣ (FlashCall + SMS):</b>
${bSms2Text}
━━━━━━━━━━━━━━</blockquote>`;

  if (loadMsg) {
    return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, text, { parse_mode: "HTML" }).catch(() => ctx.replyWithHTML(text));
  }
  return ctx.replyWithHTML(text);
});

bot.command("stats", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const fee = db.getPaymentFee();
  const wahubProfit = db.getProfit("wahub");
  const euProfit = db.getProfit("engineunicorn");
  const fastbitProfit = db.getProfit("fastbit");
  const roProfit = db.getProfit("rumahotp");
  const serverStatus = db.getServerStatus();

  ctx.replyWithHTML(
`<blockquote>📊 <b>STATISTIK BOT</b>
━━━━━━━━━━━━━━
👥 Users    : <b>${db.getTotalUsers()}</b>
🔄 TRX      : <b>${db.getTotalTrx()}</b>
💰 Income   : <b>${rupiah(db.getTotalRevenue())}</b>
💵 Profit S1 (WA) : <b>${wahubProfit.mode === "percent" ? `${wahubProfit.value}%` : rupiah(wahubProfit.value)}</b> (${serverStatus.server1 ? "🟢 Aktif" : "🔴 Tutup"})
💵 Profit S2 (WA) : <b>${euProfit.mode === "percent" ? `${euProfit.value}%` : rupiah(euProfit.value)}</b> (${serverStatus.server2 ? "🟢 Aktif" : "🔴 Tutup"})
💵 Profit S1 (SMS): <b>${fastbitProfit.mode === "percent" ? `${fastbitProfit.value}%` : rupiah(fastbitProfit.value)}</b> (${serverStatus.smsServer1 ? "🟢 Aktif" : "🔴 Tutup"})
💵 Profit S2 (FlashCall): <b>${roProfit.mode === "percent" ? `${roProfit.value}%` : rupiah(roProfit.value)}</b> (${serverStatus.smsServer2 ? "🟢 Aktif" : "🔴 Tutup"})
🧾 Fee QRIS : <b>${fee.mode === "percent" ? `${fee.value}%` : rupiah(fee.value)}</b>
📤 Depo Manual: <b>${db.getManualDeposit() ? "🟢 AKTIF" : "🔴 NONAKTIF"}</b>
🛠️ Maintenance: <b>${db.getMaintenance() ? "AKTIF" : "NONAKTIF"}</b>
━━━━━━━━━━━━━━</blockquote>`
  );
});

// ── ⭐ OWNER: RESELLER MANAGEMENT COMMANDS ─────────────────────
bot.command("resellerstatus", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const rCfg = db.getResellerSettings();
  const resellers = db.getResellers();
  const currentMonth = db.getCurrentMonth();
  const discStr = rCfg.discountMode === "percent" ? `${rCfg.discountValue}%` : rupiah(rCfg.discountValue);

  await ctx.replyWithHTML(
`<blockquote>⭐ <b>STATUS SISTEM RESELLER</b>
━━━━━━━━━━━━━━━━
🔘 Status Fitur : <b>${rCfg.enabled ? "🟢 AKTIF" : "🔴 NONAKTIF"}</b>
🎯 Target Sukses: <b>${rCfg.threshold} Transaksi / Bulan</b>
💸 Diskon Harga : <b>${discStr} (${rCfg.discountMode})</b>
🔄 Auto-Reset   : <b>${rCfg.monthlyReset ? "🟢 AKTIF (Tgl 1 tiap bulan)" : "🔴 NONAKTIF"}</b>
📅 Bulan Berjalan: <code>${currentMonth}</code>
⏮️ Reset Terakhir: <code>${rCfg.lastResetMonth || "Belum ada"}</code>
👥 Total Reseller: <b>${resellers.length} User</b>
━━━━━━━━━━━━━━━━
Ketik /ownermenu untuk daftar command konfigurasi.</blockquote>`
  );
});

bot.command("setreseller", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ownerArgs(ctx);
  const val = String(args[0] || "").toLowerCase();
  if (!["on", "off", "aktif", "nonaktif", "enable", "disable"].includes(val)) {
    return ctx.reply("❌ Format: /setreseller [on|off]\nContoh: /setreseller on");
  }
  const enabled = ["on", "aktif", "enable"].includes(val);
  db.setResellerEnabled(enabled);
  return ctx.reply(`✅ Fitur reseller berhasil diubah menjadi: ${enabled ? "🟢 AKTIF" : "🔴 NONAKTIF"}`);
});

bot.command("setresellerthreshold", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ownerArgs(ctx);
  const threshold = parseInt(args[0]);
  if (isNaN(threshold) || threshold < 1) {
    return ctx.reply("❌ Format: /setresellerthreshold [jumlah_transaksi]\nContoh: /setresellerthreshold 100");
  }
  db.setResellerThreshold(threshold);
  return ctx.reply(`✅ Syarat transaksi bulanan reseller diubah menjadi: ${threshold} transaksi sukses.`);
});

bot.command("setresellerdiscount", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ownerArgs(ctx);
  let mode = String(args[0] || "").toLowerCase();
  let val = Number(args[1]);

  if (["flat", "percent", "persen", "rp"].includes(mode)) {
    mode = (mode === "percent" || mode === "persen") ? "percent" : "flat";
  } else if (!isNaN(Number(mode)) && !args[1]) {
    val = Number(mode);
    mode = "flat";
  } else {
    return ctx.reply("❌ Format: /setresellerdiscount [flat|percent] [nilai]\nContoh:\n• /setresellerdiscount flat 500\n• /setresellerdiscount percent 10");
  }

  if (isNaN(val) || val < 0) {
    return ctx.reply("❌ Nilai diskon harus berupa angka positif.");
  }
  if (mode === "percent" && val > 100) {
    return ctx.reply("❌ Diskon persentase tidak boleh lebih dari 100%.");
  }

  db.setResellerDiscount(mode, val);
  const discStr = mode === "percent" ? `${val}%` : rupiah(val);
  return ctx.reply(`✅ Diskon harga reseller diubah menjadi: ${discStr} (${mode}).`);
});

bot.command("setresellermonthly", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const args = ownerArgs(ctx);
  const val = String(args[0] || "").toLowerCase();
  if (!["on", "off", "aktif", "nonaktif"].includes(val)) {
    return ctx.reply("❌ Format: /setresellermonthly [on|off]\nContoh: /setresellermonthly on");
  }
  const enabled = ["on", "aktif"].includes(val);
  db.setResellerMonthlyReset(enabled);
  return ctx.reply(`✅ Auto-reset transaksi reseller bulanan diubah menjadi: ${enabled ? "🟢 AKTIF" : "🔴 NONAKTIF"}`);
});

bot.command(["addreseller", "promotereseller"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const { userId, searchedUsername } = resolveTargetUser(ctx, ownerArgs(ctx));
  if (searchedUsername && !userId) {
    return ctx.reply(`❌ Username ${searchedUsername} belum terdaftar di bot.`);
  }
  if (!userId) {
    return ctx.reply("❌ Format: /addreseller [userId/@username]\nContoh: /addreseller 123456789 atau /addreseller @username");
  }

  const user = db.getUser(userId);
  if (!user) return ctx.reply(`❌ User ${userId} belum terdaftar di bot.`);

  db.setUserReseller(userId, true, true);
  await ctx.replyWithHTML(
    `<blockquote>⭐ <b>PROMOSI RESELLER BERHASIL</b>
━━━━━━━━━━━━━━━━
👤 User: <code>${userId}</code> (${user.username ? `@${escapeHTML(user.username)}` : "Member"})
🎖️ Role: <b>Reseller (Manual Promotion)</b>
━━━━━━━━━━━━━━━━
User sekarang mendapatkan harga khusus reseller!</blockquote>`
  );
  bot.telegram.sendMessage(
    userId,
    `<blockquote>🎉 <b>SELAMAT! KAMU MENJADI RESELLER</b>
━━━━━━━━━━━━━━━━
Owner telah memberikan kamu role <b>⭐ Reseller</b>!
Mulai sekarang kamu berhak mendapatkan harga khusus reseller yang lebih murah di setiap transaksi nomor.
━━━━━━━━━━━━━━━━
Cek status dan harga khusus di menu <b>⭐ Reseller</b> atau /reseller</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
});

bot.command(["delreseller", "demotereseller"], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const { userId, searchedUsername } = resolveTargetUser(ctx, ownerArgs(ctx));
  if (searchedUsername && !userId) {
    return ctx.reply(`❌ Username ${searchedUsername} belum terdaftar di bot.`);
  }
  if (!userId) {
    return ctx.reply("❌ Format: /delreseller [userId/@username]\nContoh: /delreseller 123456789 atau /delreseller @username");
  }

  const user = db.getUser(userId);
  if (!user) return ctx.reply(`❌ User ${userId} belum terdaftar di bot.`);

  db.setUserReseller(userId, false, false);
  await ctx.replyWithHTML(
    `<blockquote>ℹ️ Role reseller untuk user <code>${userId}</code> telah <b>dicabut</b>.</blockquote>`
  );
  bot.telegram.sendMessage(
    userId,
    `<blockquote>ℹ️ Status role Reseller kamu telah dinonaktifkan oleh owner.</blockquote>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
});

bot.command("listreseller", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const resellers = db.getResellers();
  if (!resellers.length) {
    return ctx.replyWithHTML("<blockquote>ℹ️ Belum ada user dengan role Reseller.</blockquote>");
  }

  const lines = resellers.slice(0, 50).map((u, i) => {
    const name = u.username ? `@${escapeHTML(u.username)}` : `User ${u.id}`;
    const isManual = Boolean(u.isManualReseller || u.isManual);
    const badge = isManual ? "🛠️ Manual" : "🏆 Target";
    const userCoin = u.coin !== undefined && u.coin !== null ? u.coin : (db.getCoin(u.id) || 0);
    return `${i + 1}. <b>${name}</b> (<code>${u.id}</code>)\n   └ ${badge} · Bulan ini: <b>${u.monthlyTrx || 0}</b> trx · Coin: <b>${rupiah(userCoin)}</b>`;
  });

  await ctx.replyWithHTML(
`<blockquote>⭐ <b>DAFTAR RESELLER (${resellers.length} User)</b>
━━━━━━━━━━━━━━━━
${lines.join("\n")}
━━━━━━━━━━━━━━━━
${resellers.length > 50 ? `<i>Menampilkan 50 dari ${resellers.length} user.</i>` : ""}</blockquote>`
  );
});

bot.command("resetreseller", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const currentMonth = db.getCurrentMonth();
  const resetCount = db.resetMonthlyReseller(currentMonth);
  await ctx.replyWithHTML(
`<blockquote>🔄 <b>MANUAL RESET RESELLER SELESAI</b>
━━━━━━━━━━━━━━━━
📅 Periode Bulan : <code>${currentMonth}</code>
👥 User Direset  : <b>${resetCount} User</b>
━━━━━━━━━━━━━━━━
Transaksi bulanan reseller (monthlyTrx) telah direset ke 0.
<i>Catatan: Lifetime transaksi & Top Buyer tetap aman tidak tersentuh.</i></blockquote>`
  );
});

// ── /backup — Zip seluruh file bot tanpa node_modules ─────
async function sendBotBackup(ctx) {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");
  const archiveName = `backup_bot_${Date.now()}.zip`;
  const archivePath = path.join(__dirname, archiveName);
  try {
    await execFileAsync(
      "zip",
    [
  "-qr",
  archiveName,
  ".",
  "-x",
  "node_modules/*",
  "node_modules/**",
  ".npm/*",
  ".npm/**",
  archiveName
],
      { cwd: __dirname }
    );
    await ctx.replyWithDocument(
      { source: archivePath, filename: archiveName },
      { caption: `🗄️ Backup bot \n📅 ${getWaktu()}` }
    );
  } catch (error) {
    await ctx.reply("❌ Gagal membuat backup ZIP. Pastikan utilitas zip tersedia.");
  } finally {
    await fs.promises.unlink(archivePath).catch(() => {});
  }
}

bot.command("backup", sendBotBackup);

// ── /setbackup — Kirim backup db.json ke owner ────────────
bot.command("setbackup", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");

  const dbPath = path.join(__dirname, "db.json");
  if (!fs.existsSync(dbPath)) return ctx.reply("❌ File db.json tidak ditemukan.");

  let dbData;
  try {
    dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  } catch (e) {
    return ctx.reply("❌ Gagal baca db.json: " + e.message);
  }

  // Hitung statistik
  const totalUsers    = Object.keys(dbData.users || {}).length;
  const totalTrx      = (dbData.transactions || []).length;
  const totalDeposit  = (dbData.deposits || []).length;
  const totalRevenue  = dbData.totalRevenue || 0;
  const depositSucc   = (dbData.deposits || []).filter(d => d.status === "approved" || d.status === "success").length;
  const depositPend   = (dbData.deposits || []).filter(d => d.status === "pending" || d.status === "waiting_payment").length;
  const totalCoinUser = Object.values(dbData.users || {}).reduce((sum, u) => sum + (u.coin || 0), 0);

  // Top 3 user by trx
  const topUsers = Object.entries(dbData.users || {})
    .map(([id, u]) => ({ id, username: u.username || id, trx: u.trx || 0 }))
    .sort((a, b) => b.trx - a.trx)
    .slice(0, 3);

  const topStr = topUsers.length
    ? topUsers.map((u, i) => `  ${["🥇", "🥈", "🥉"][i]} @${u.username} — ${u.trx}x TRX`).join("\n")
    : "  (belum ada)";

  const caption =
`<blockquote>🗄️ <b>BACKUP DATABASE BOT</b>
━━━━━━━━━━━━━━━━
📅 Waktu Backup : ${getWaktu()}

👥 <b>USER</b>
├ Total User     : <b>${totalUsers}</b>
└ Total Coin     : <b>${rupiah(totalCoinUser)}</b>

🔄 <b>TRANSAKSI</b>
└ Total TRX      : <b>${totalTrx}</b>

💰 <b>DEPOSIT</b>
├ Total Deposit  : <b>${totalDeposit}</b>
├ Berhasil       : <b>${depositSucc}</b>
├ Menunggu       : <b>${depositPend}</b>
└ Total Revenue  : <b>${rupiah(totalRevenue)}</b>

🏆 <b>TOP USER</b>
${topStr}
━━━━━━━━━━━━━━━━
📁 File: db.json (lengkap di attachment)</blockquote>`;

  await ctx.replyWithDocument(
    { source: Buffer.from(JSON.stringify(dbData, null, 2)), filename: `backup_db_${Date.now()}.json` },
    { caption, parse_mode: "HTML" }
  );
});

// ── /apikey — Developer API Key Management (1 Key Per Akun) ──────
async function showApiKeyMenu(ctx) {
  const uid = ctx.from.id;
  db.registerUser(uid, ctx.from.username || ctx.from.first_name);

  const docsUrl = config.API_DOCS_URL || "https://api.calabay.my.id";

  // Ambil atau otomatis buatkan 1 API key aktif untuk akun ini
  const keyData = await apiKeys.getOrCreateApiKey(uid);

  if (!keyData || !keyData.success) {
    const errText = `<blockquote>❌ <b>GAGAL MEMUAT API KEY</b>
━━━━━━━━━━━━━━━━
${escapeHTML(keyData?.error || "Terjadi kesalahan saat memuat API Key Anda.")}
Silakan coba beberapa saat lagi.</blockquote>`;
    if (ctx.callbackQuery) {
      return ctx.editMessageText(errText, { parse_mode: "HTML" }).catch(() => ctx.replyWithHTML(errText));
    }
    return ctx.replyWithHTML(errText);
  }

  const lastUsedText = keyData.lastUsed
    ? new Date(keyData.lastUsed).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    : "Belum pernah";

  const messageText = `<blockquote>🔑 <b>CALABAY DEVELOPER API</b>
━━━━━━━━━━━━━━━━
Gunakan API untuk order OTP secara otomatis dari program / script Anda.
Saldo coin yang digunakan terhubung langsung dengan bot Telegram ini.

🔑 <b>API Key Anda:</b>
<code>${keyData.key}</code>
👆 <i>Ketuk teks key di atas untuk langsung menyalin</i>

📊 Status: <b>✅ Aktif</b>
📈 Penggunaan: <b>${keyData.totalRequests || 0} request</b>
⏰ Terakhir Dipakai: <b>${lastUsedText}</b>
━━━━━━━━━━━━━━━━
🌐 <b>Base URL:</b>
<code>${docsUrl}/api/v1</code>

📖 <b>Header Autentikasi:</b>
<code>Authorization: Bearer ${keyData.key}</code>
━━━━━━━━━━━━━━━━
⚠️ <i>Key ini bersifat rahasia. Jangan bagikan kepada orang lain!</i></blockquote>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔄 Ganti Key Baru", callback_data: `apikey_regen_${uid}` },
        { text: "🗑️ Matikan Key", callback_data: `apikey_revoke_${uid}` },
      ],
      [{ text: "📖 Buka API Docs", url: docsUrl }],
      [{ text: "🔙 Menu Utama", callback_data: `apikey_back_home_${uid}` }],
    ],
  };

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(messageText, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      return;
    } catch {
      // Fallback if edit not possible
    }
  }

  await ctx.replyWithHTML(messageText, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
}

bot.command("apikey", showApiKeyMenu);
bot.hears(["🔑 API Key", "API Key", "apikey", "api key", "Developer API"], showApiKeyMenu);

bot.action(/^apikey_menu_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return ctx.answerCbQuery("❌ Bukan akun kamu.", { show_alert: true });
  await ctx.answerCbQuery();
  await showApiKeyMenu(ctx);
});

bot.action(/^apikey_regen_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return ctx.answerCbQuery("❌ Bukan akun kamu.", { show_alert: true });
  await ctx.answerCbQuery("⏳ Membuat API key baru...");

  const res = await apiKeys.regenerateApiKey(uid);
  if (!res.success) {
    return ctx.replyWithHTML(`<blockquote>❌ Gagal membuat key baru: ${escapeHTML(res.error)}</blockquote>`);
  }
  await showApiKeyMenu(ctx);
});

bot.action(/^apikey_revoke_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return ctx.answerCbQuery("❌ Bukan akun kamu.", { show_alert: true });
  await ctx.answerCbQuery("🗑️ Menonaktifkan key...");

  await apiKeys.revokeAllApiKeys(uid);
  const docsUrl = config.API_DOCS_URL || "https://api.calabay.my.id";

  const revokeText = `<blockquote>🗑️ <b>API KEY DINONAKTIFKAN</b>
━━━━━━━━━━━━━━━━
API Key Anda telah dinonaktifkan (Revoked) dan tidak dapat digunakan lagi untuk memanggil API.

Tekan tombol di bawah untuk mengaktifkan kembali API Key baru kapan saja.</blockquote>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔑 Aktifkan API Key Baru", callback_data: `apikey_regen_${uid}` }],
      [{ text: "📖 Buka API Docs", url: docsUrl }],
      [{ text: "🔙 Menu Utama", callback_data: `apikey_back_home_${uid}` }],
    ],
  };

  try {
    await ctx.editMessageText(revokeText, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
  } catch {
    await ctx.replyWithHTML(revokeText, {
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
  }
});

bot.action(/^apikey_back_home_(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[1]);
  if (uid !== ctx.from.id) return ctx.answerCbQuery("❌ Bukan akun kamu.", { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await showMainMenu(ctx, uid);
});

// Backwards compatibility for legacy button callbacks
bot.action(/^(apikey_gen_|apikey_list_|apikey_clean_|apikey_revoke_all_)(\d+)$/, async (ctx) => {
  const uid = parseInt(ctx.match[2]);
  if (uid !== ctx.from.id) return ctx.answerCbQuery("❌ Bukan akun kamu.", { show_alert: true });
  await ctx.answerCbQuery();
  await showApiKeyMenu(ctx);
});

bot.command("help", async (ctx) => {
  const ownerPart = isOwner(ctx)
    ? `\n<b>👑 OWNER</b>
/ownermenu — Semua command owner
/addsaldo [userId/@username] [jumlah] — Tambah saldo
/delsaldo [userId/@username] [jumlah] — Kurangi saldo
/listuser — Daftar user bot
/listtransaksi [jumlah] — Transaksi terbaru
 /setprofit — Atur profit flat per layanan
/setfee [persen|flat] [nilai] — Atur fee QRIS
/manualdeposit [on|off] — Atur ON/OFF deposit manual
/maintenance — Mode maintenance
/wajibjoin [on|off] — Atur wajib join
/addjoin [@username|link] — Tambah channel/grup wajib join
/listjoin — Daftar channel/grup wajib join
/deljoin [nomor|link] — Hapus channel/grup wajib join
/referral [on|off] — Aktif/nonaktif referral
/setreferral [bonus] — Atur bonus referral
/referralstatus — Status referral
/backup — Backup ZIP tanpa node_modules
/setqris [url] — Update QRIS manual
/setbackup — Backup database ke sini
 /ceksaldo — Cek saldo layanan
/stats — Statistik bot
/broadcast — Reply pesan lalu ketik ini untuk broadcast` : "";

  ctx.replyWithHTML(
`<blockquote>📋 <b>COMMANDS</b>
━━━━━━━━━━━━━━
<b>👤 USER</b>
/start — Menu utama
/buynokos — Beli nokos
/deposit — Deposit coin
/referral — Lihat kode dan link referral
/apikey — Developer API (generate key)
/help — Bantuan${ownerPart}
━━━━━━━━━━━━━━
💬 ${config.urladmin}</blockquote>`
  );
});

// ── /broadcast (OWNER) ────────────────────────────────────
bot.command("broadcast", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("❌ Khusus owner.");

  const reply = ctx.message.reply_to_message;
  if (!reply) {
    return ctx.replyWithHTML(
`<blockquote>❓ <b>Cara pakai:</b>
Reply pesan yang mau di-broadcast, lalu ketik /broadcast</blockquote>`
    );
  }

  const dbData  = JSON.parse(fs.readFileSync(path.join(__dirname, "db.json"), "utf-8"));
  const userIds = Object.keys(dbData.users || {});

  if (!userIds.length) return ctx.reply("❌ Tidak ada user.");

  const loadMsg = await ctx.replyWithHTML(
    `<blockquote>📡 <b>Broadcasting ke ${userIds.length} user...</b></blockquote>`
  );

  let sukses = 0, gagal = 0;

  for (const uid of userIds) {
    try {
      await bot.telegram.forwardMessage(uid, ctx.chat.id, reply.message_id);
      sukses++;
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      gagal++;
    }
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id, loadMsg.message_id, null,
`<blockquote>📡 <b>BROADCAST SELESAI</b>
━━━━━━━━━━━━━━━━
✅ Terkirim : <b>${sukses}</b>
❌ Gagal    : <b>${gagal}</b>
👥 Total    : <b>${userIds.length}</b>
━━━━━━━━━━━━━━━━</blockquote>`,
    { parse_mode: "HTML" }
  );
});

// ── Database Backup System ─────────────────────────────────
const BACKUP_TARGET_ID = process.env.BACKUP_TARGET_ID || "7050529580";
const BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 Jam

async function performDatabaseBackup(targetChatId = BACKUP_TARGET_ID, isManual = false) {
  try {
    const files = [];
    const candidates = ["db.json", "sessions.json", "profit.json", "config.js"];
    for (const fname of candidates) {
      const fpath = path.join(__dirname, fname);
      if (fs.existsSync(fpath)) {
        files.push({ name: fname, data: fs.readFileSync(fpath) });
      }
    }
    if (!files.length) return false;

    const zipBuffer = createZip(files);
    const now = new Date();
    const timeStr = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const fileDate = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const zipFileName = `backup-db-${fileDate}.zip`;
    const sizeKb = (zipBuffer.length / 1024).toFixed(1);

    const totalUsers = db.getTotalUsers ? db.getTotalUsers() : (db.getUsers ? db.getUsers().length : 0);
    const totalTrx = db.getTransactions ? db.getTransactions(1000).length : 0;

    const caption = `<blockquote>📦 <b>${isManual ? "MANUAL" : "AUTO"} BACKUP DATABASE</b>
━━━━━━━━━━━━━━━━
📁 File: <code>${zipFileName}</code>
📊 Ukuran: <b>${sizeKb} KB</b>
👥 Total User: <b>${totalUsers}</b>
🧾 Total Transaksi: <b>${totalTrx}</b>
🕐 Waktu: <b>${timeStr}</b>
━━━━━━━━━━━━━━━━
✅ Backup database berhasil diamankan.</blockquote>`;

    await bot.telegram.sendDocument(
      targetChatId,
      { source: zipBuffer, filename: zipFileName },
      { caption, parse_mode: "HTML" }
    );
    console.log(`[BACKUP] Successfully sent ${zipFileName} (${sizeKb} KB) to ${targetChatId}`);
    return true;
  } catch (err) {
    console.error("[BACKUP ERROR]", err.message);
    return false;
  }
}

// ── Launch ────────────────────────────────────────────────
const userCommands = [
{ command: "start", description: "Menu Utama" }     
];
bot.telegram.setMyCommands(userCommands);

async function restoreWahubPollers() {
  for (const { userId, session } of wahubSessionDb.list()) {
    if (!session || typeof session !== "object") {
      wahubSessionDb.remove(userId);
      continue;
    }
    const isWaiting = session.status === "waiting" || isWahubWaitingSession(session);
    if (isWaiting) {
      if (["fastbit", "herosms", "rumahotp"].includes(session.provider)) {
        pollApiSmsOrder({ ...session, userId });
      } else {
        pollWahub(userId, session.sessionKey || session.trxId || session.orderId);
      }
    }
  }
}

async function restorePendingDeposits() {
  const dbData = db.load ? db.load() : null;
  if (!dbData || !Array.isArray(dbData.deposits)) return;

  const now = Date.now();
  const maxAgeMs = 15 * 60 * 1000;
  const pollIntervalMs = config.PANZZPAY?.pollIntervalMs || config.PAYMENT_GATEWAY?.pollIntervalMs || 4000;

  for (const dep of dbData.deposits) {
    if (dep.type === "auto_qris" && dep.status === "waiting_payment" && dep.idtransaksi) {
      const createdAt = new Date(dep.date).getTime();
      const timeLeft = maxAgeMs - (now - createdAt);

      if (timeLeft <= 0) {
        db.updateDeposit(dep.id, "expired");
        continue;
      }

      const uid = dep.userId;
      if (activeTransactions[uid]) continue;

      let isChecking = false;

      const expireTimeout = setTimeout(() => {
        const current = db.getDeposit(dep.id);
        if (current && current.status === "waiting_payment") {
          db.updateDeposit(dep.id, "expired");
          if (activeTransactions[uid]?.depoId === dep.id) {
            clearInterval(activeTransactions[uid].interval);
            delete activeTransactions[uid];
          }
        }
      }, timeLeft);

      const interval = setInterval(async () => {
        if (isChecking) return;
        isChecking = true;
        try {
          const isPaid = await cekPaid({ orderId: dep.idtransaksi }, config);
          if (isPaid) {
            clearInterval(interval);
            clearTimeout(expireTimeout);
            await handleDepositSuccess(dep.id, "QRIS Otomatis (PanzzPay)");
          }
        } catch (e) {
          console.error("[RESTORE CEK ERROR]", e.message);
        } finally {
          isChecking = false;
        }
      }, pollIntervalMs);

      activeTransactions[uid] = {
        depoId: dep.id,
        interval,
        expireTimeout,
        orderId: dep.idtransaksi,
      };
      console.log(`[DEPOSIT RESTORE] Polling cepat dipulihkan untuk user ${uid} (${dep.idtransaksi})`);
    }
  }
}

// ── MongoDB + Bot Startup ───────────────────────────────────
(async () => {
  try {
    // 1. Connect to MongoDB Atlas
    console.log("🔗 [MongoDB] Menghubungkan ke MongoDB Atlas...");
    const mongoConnected = await db.connectMongo(config.MONGO_URI);

    // 2. Load sessions from MongoDB if connected
    if (mongoConnected) {
      await wahubSessionDb.loadSessionsFromMongo();
    }

    // 3. Initialize API Keys & Start Express API Server
    try {
      if (mongoConnected) {
        await apiKeys.init();
      }
      const apiApp = createApiServer({
        sendRealtimeOtp: sendChannelRealtimeOtpNotification,
        sendOrderReport: sendChannelOrderReportNotification,
        onOrderCreated: (sess) => {
          if (!sess) return;
          if (sess.provider === "wahub" || sess.provider === "engineunicorn") {
            pollWahub(sess.userId, sess.sessionKey || sess.trxId || sess.orderId);
          } else if (sess.provider === "fastbit" || sess.provider === "herosms" || sess.provider === "rumahotp") {
            pollApiSmsOrder(sess);
          }
        },
      });
      const apiPort = config.API_PORT || 5061;
      apiApp.listen(apiPort, () => {
        console.log(`🌐 [API Server] Developer API aktif di port ${apiPort}`);
        console.log(`📖 [API Docs] http://localhost:${apiPort}/docs`);
      });
    } catch (apiErr) {
      console.error("⚠️ [API Server] Gagal start:", apiErr.message);
    }

    // 4. Jalankan auto-backup database setiap 1 jam sekali ke ID 7050529580
    setInterval(() => {
      performDatabaseBackup(BACKUP_TARGET_ID, false);
    }, BACKUP_INTERVAL_MS);
    console.log(`📦 Auto backup database aktif setiap 1 jam ke Telegram ID: ${BACKUP_TARGET_ID}`);

    // 5. Restore background jobs & polling
    syncRealtimeChannelToMandatoryJoin();
    await restoreWahubPollers();
    console.log("✅ Polling WAHUB dipulihkan.");

    await restorePendingDeposits();
    console.log("⚡ Polling cepat pembayaran PanzzPay aktif!");

    // 6. Launch Telegram Bot
    await bot.launch();
    console.log("✅ Bot Telegram aktif!");

    // Cek auto-reset transaksi bulanan reseller saat startup
    try {
      const currentMonth = db.getCurrentMonth();
      const rCfg = db.getResellerSettings();
      if (rCfg.monthlyReset && rCfg.lastResetMonth !== currentMonth) {
        const resetCount = db.resetMonthlyReseller(currentMonth);
        if (resetCount > 0) {
          console.log(`⭐ [Reseller] Auto-reset awal bulan (${currentMonth}) diproses untuk ${resetCount} user.`);
        }
      }
    } catch (err) {
      console.error("❌ [Reseller Startup Check Error]:", err.message);
    }

    // Interval cek auto-reset bulanan reseller setiap 10 menit
    setInterval(() => {
      try {
        const curM = db.getCurrentMonth();
        const cfg = db.getResellerSettings();
        if (cfg.monthlyReset && cfg.lastResetMonth !== curM) {
          const resetCount = db.resetMonthlyReseller(curM);
          console.log(`⭐ [Reseller] Auto-reset awal bulan (${curM}) dijalankan untuk ${resetCount} user.`);
        }
      } catch (err) {
        console.error("❌ [Reseller Interval Reset Error]:", err.message);
      }
    }, 10 * 60 * 1000);

    if (mongoConnected) {
      console.log("🌐 [MongoDB] Bot berjalan dengan database MongoDB Atlas (Cloud)!");
    } else {
      console.log("⚠️  [MongoDB] Bot berjalan dengan database lokal (db.json) - fallback mode");
    }
  } catch (e) {
    console.error("❌ Launch error:", e.message);
  }
})();

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));