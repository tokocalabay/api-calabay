/**
 * Vercel Serverless Function Entry Point
 * 
 * Wraps the Express API server for Vercel serverless deployment.
 * MongoDB connection is cached across warm invocations.
 */
const { createApiServer } = require("../api-server");
const db = require("../db");
const apiKeys = require("../lib/api-keys");
const config = require("../config");

const mongoose = require("mongoose");

let initialized = false;
const app = createApiServer();

module.exports = async (req, res) => {
  // Pastikan MongoDB terhubung (re-connect jika cold start / koneksi drop)
  if (!initialized || !db.isMongoReady()) {
    try {
      const connected = await db.connectMongo(config.MONGO_URI);
      if (connected) {
        await apiKeys.init();
        console.log("✅ [Vercel] MongoDB + API Keys initialized");
        initialized = true;
      }
    } catch (err) {
      console.error("⚠️ [Vercel] Init error:", err.message);
    }
  }

  return app(req, res);
};
