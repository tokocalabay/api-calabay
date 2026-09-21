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

let initialized = false;
const app = createApiServer();

module.exports = async (req, res) => {
  // Initialize MongoDB + API keys once per cold start
  if (!initialized) {
    try {
      const connected = await db.connectMongo(config.MONGO_URI);
      if (connected) {
        await apiKeys.init();
        console.log("✅ [Vercel] MongoDB + API Keys initialized");
      }
      initialized = true;
    } catch (err) {
      console.error("⚠️ [Vercel] Init error:", err.message);
      initialized = true; // Don't retry on every request
    }
  }

  return app(req, res);
};
