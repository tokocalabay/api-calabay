module.exports = {

  BOT_TOKEN: "8408915872:AAGaE1v70PKm2W5TFvA5JRLRGACNRHpkaxc",
  OWNER_ID: "7050529580",
  OWNER_IDS: ["7050529580", "1577396317"],
  urladmin: "https://t.me/Adm_Calabay",
  CHANNEL_USERNAME: "@tokocalabay",
  CHANNEL_NOTIF_REALTIME: "@notifcalabay", // Khusus channel notif realtime (ganti dengan @username atau ID channel kamu)
  CHANNEL_NOTIF_ORDER: process.env.CHANNEL_NOTIF_ORDER || "@ydhadescater", // Khusus channel laporan order OTP (ganti dengan @username atau ID channel kamu)
  BOT_LINK: "https://t.me/Calabayybot",

  // ── SERVER 1: WAHUB OTP ─────────────────────────────────
  WAHUB_API_URL: "https://dehuyzotp.shop",
  WAHUB_API_TOKEN: "wh_6b6a4b61f0888db075a1ec2081a47015831d50017986d9060cd30a4f3c87c53a",

  // ── SERVER 2: NINJA OTP (https://app.ninjatop.cloud/dokumentasi) ─
  NINJAOTP_API_URL: process.env.NINJAOTP_API_URL || "https://app.ninjatop.cloud/api/public/v1",
  NINJAOTP_API_KEY: process.env.NINJAOTP_API_KEY || "nk_044282e51ea7e33705f78ebf9c9e6e85515aa044bb1d744d", // Ganti dengan API Key Ninja OTP Anda (format: nk_...)
  // Fallback kompatibilitas:
  ENGINEUNICORN_API_URL: process.env.NINJAOTP_API_URL || "https://app.ninjatop.cloud/api/public/v1",
  ENGINEUNICORN_API_KEY: process.env.NINJAOTP_API_KEY || "nk_044282e51ea7e33705f78ebf9c9e6e85515aa044bb1d744d",

  // ── OTP SMS SERVER 1: FASTBIT (https://fastbit.co.id) ────
  FASTBIT_API_URL: process.env.FASTBIT_API_URL || "https://fastbit.co.id",
  FASTBIT_API_KEY: process.env.FASTBIT_API_KEY || "CCaU2XV8a89QfkIm5P1HygVFi0AOREzrtBOm3i2QovO3l0jdO7krVi88ygRN",

  // ── OTP SMS SERVER 2: HERO SMS FlashCall (https://hero-sms.com) ──
  HERO_SMS_API_URL: process.env.HERO_SMS_API_URL || "https://hero-sms.com",
  HERO_SMS_API_KEY: process.env.HERO_SMS_API_KEY || "9dbAd5c9bfc8c900b8bbedb40d1d5AA3",
  HERO_SMS_USD_TO_IDR: Number(process.env.HERO_SMS_USD_TO_IDR || 16000),

  // Fallback kompatibilitas RumahOTP (legacy):
  RUMAHOTP_API_URL: process.env.RUMAHOTP_API_URL || "https://www.rumahotp.io/api",
  RUMAHOTP_API_KEY: process.env.RUMAHOTP_API_KEY || "rk-dev-EKlPS39ErkJ6AhPKpTjWtc5NQ9NA1KDD",

  // ── PAYMENT MANUAL ──────────────────────────────────────
  QRIS_URL: "https://files.catbox.moe/9jhdzv.jpg",
  DANA_NUMBER: "081243433133",
  DANA_NAME: "YUDA AFRIZAL",

  // ── PAYMENT OTOMATIS (PANZZPAY - https://panzzpay.my.id/docs) ─
  PAYMENT_GATEWAY: {
    baseUrl: "https://panzzpay.my.id",
    apiKey: "np_live_k4pbeoutucwyykqg1u", // Ganti dengan API Key PanzzPay Anda
    webhookUrl: "https://panzzpay.my.id/webhook", // Opsional/URL webhook jika ada
    botName: "Toko Calabay",
    expiredInMinutes: 15,
    pollIntervalMs: 4000, // Polling setiap 3-5 detik sesuai dokumentasi PanzzPay
  },

  // ── GAMBAR START BOT ────────────────────────────────────
  START_IMAGE: "https://files.catbox.moe/fi86nr.jpg",  // Ganti dengan URL gambar untuk welcome

  // ── MONGODB ────────────────────────────────────────────
  MONGO_URI: process.env.MONGO_URI || "mongodb+srv://tokocalabay_db_user:pJ7hCzNXVyxhUqGE@dbcalabay.rsy9rax.mongodb.net/calabay_bot?retryWrites=true&w=majority&appName=Dbcalabay",

  // ── DEVELOPER API ─────────────────────────────────────
  API_PORT: Number(process.env.API_PORT || 5061),
  API_DOCS_URL: process.env.API_BASE_URL || process.env.API_DOCS_URL || "https://api.calabay.my.id",



};

module.exports.PANZZPAY = module.exports.PAYMENT_GATEWAY;
module.exports.PAYQRIS = module.exports.PAYMENT_GATEWAY;
