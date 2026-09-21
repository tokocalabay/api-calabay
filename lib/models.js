const mongoose = require("mongoose");

// ── User Schema ─────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  userId:           { type: String, required: true, unique: true, index: true },
  username:         { type: String, default: "" },
  coin:             { type: Number, default: 0 },
  trx:              { type: Number, default: 0 },
  referralCode:     { type: String, default: "", index: true },
  referredBy:       { type: String, default: null },
  referralRewarded: { type: Boolean, default: false },
  referralCount:    { type: Number, default: 0 },
  referralEarned:   { type: Number, default: 0 },
  isReseller:       { type: Boolean, default: false },
  isManualReseller: { type: Boolean, default: false },
  resellerUnlockedAt: { type: String, default: null },
  monthlyTrx:       { type: Number, default: 0 },
  lastTrxMonth:     { type: String, default: () => new Date().toISOString().slice(0, 7) },
  joinedAt:         { type: String, default: () => new Date().toISOString() },
}, { timestamps: true });

// ── Transaction Schema ──────────────────────────────────────
const transactionSchema = new mongoose.Schema({
  id:            { type: String, required: true, unique: true, index: true },
  userId:        { type: String, required: true, index: true },
  username:      { type: String, default: "" },
  orderId:       { type: String, default: "" },
  phone:         { type: String, default: "" },
  productName:   { type: String, default: "" },
  negara:        { type: String, default: "" },
  harga:         { type: Number, default: 0 },
  provider:      { type: String, default: "" },
  serviceId:     { type: String, default: "" },
  countryId:     { type: String, default: "" },
  operatorId:    { type: String, default: "" },
  providerPrice: { type: Number, default: null },
  refunded:      { type: Boolean, default: false },
  refundedAt:    { type: String, default: null },
  date:          { type: String, default: () => new Date().toISOString() },
}, { timestamps: true });

// ── Deposit Schema ──────────────────────────────────────────
const depositSchema = new mongoose.Schema({
  id:            { type: String, required: true, unique: true, index: true },
  userId:        { type: String, required: true, index: true },
  username:      { type: String, default: "" },
  nominal:       { type: Number, default: 0 },
  idtransaksi:   { type: String, default: "" },
  fotoId:        { type: String, default: null },
  paymentAmount: { type: Number, default: 0 },
  fee:           { type: Number, default: 0 },
  chatId:        { type: String, default: "" },
  msgId:         { type: Number, default: null },
  status:        { type: String, default: "pending" },
  type:          { type: String, default: "manual" },
  date:          { type: String, default: () => new Date().toISOString() },
}, { timestamps: true });

// ── Settings Schema (single document) ───────────────────────
const settingSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true, default: "main" },
  wahub: {
    profit: {
      mode:  { type: String, default: "flat" },
      value: { type: Number, default: 100 },
    },
  },
  providers: {
    wahub:         { type: Boolean, default: true },
    engineunicorn: { type: Boolean, default: true },
    otpcepat:      { type: Boolean, default: true },
    herosms:       { type: Boolean, default: true },
    rumahotp:      { type: Boolean, default: true },
  },
  profit: {
    wahub:         { mode: { type: String, default: "flat" }, value: { type: Number, default: 100 } },
    engineunicorn: { mode: { type: String, default: "flat" }, value: { type: Number, default: 100 } },
    otpcepat:      { mode: { type: String, default: "flat" }, value: { type: Number, default: 0 } },
    herosms:       { mode: { type: String, default: "flat" }, value: { type: Number, default: 500 } },
    rumahotp:      { mode: { type: String, default: "flat" }, value: { type: Number, default: 500 } },
  },
  paymentFee: {
    mode:  { type: String, default: "flat" },
    value: { type: Number, default: 0 },
  },
  maintenance:  { type: Boolean, default: false },
  manualDeposit:{ type: Boolean, default: true },
  mandatoryJoin: {
    enabled: { type: Boolean, default: false },
    chats:   { type: Array, default: [] },
  },
  referral: {
    enabled:           { type: Boolean, default: false },
    reward:            { type: Number, default: 0 },
    commissionPercent: { type: Number, default: 10 },
  },
  reseller: {
    enabled:           { type: Boolean, default: true },
    threshold:         { type: Number, default: 100 },
    discountMode:      { type: String, default: "flat" },
    discountValue:     { type: Number, default: 200 },
    monthlyReset:      { type: Boolean, default: true },
    lastResetMonth:    { type: String, default: () => new Date().toISOString().slice(0, 7) },
  },
  totalRevenue: { type: Number, default: 0 },
}, { timestamps: true });

// ── Session Schema (WAHUB polling sessions) ─────────────────
const sessionSchema = new mongoose.Schema({
  userId:     { type: String, required: true, index: true },
  sessionKey: { type: String, default: "" },
  data:       { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// ── Profit DB Schema ────────────────────────────────────────
const profitSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, default: "main" },
  version:   { type: Number, default: 1 },
  providers: { type: mongoose.Schema.Types.Mixed, default: {} },
  services:  { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// ── API Key Schema ──────────────────────────────────────────
const apiKeySchema = new mongoose.Schema({
  userId:        { type: String, required: true, index: true },
  key:           { type: String, required: true, unique: true, index: true },
  label:         { type: String, default: "default" },
  isActive:      { type: Boolean, default: true },
  createdAt:     { type: String, default: () => new Date().toISOString() },
  lastUsed:      { type: String, default: null },
  totalRequests: { type: Number, default: 0 },
}, { timestamps: true });

// ── Export Models ────────────────────────────────────────────
module.exports = {
  User:        mongoose.model("User", userSchema),
  Transaction: mongoose.model("Transaction", transactionSchema),
  Deposit:     mongoose.model("Deposit", depositSchema),
  Setting:     mongoose.model("Setting", settingSchema),
  Session:     mongoose.model("Session", sessionSchema),
  Profit:      mongoose.model("Profit", profitSchema),
  ApiKey:      mongoose.model("ApiKey", apiKeySchema),
};
