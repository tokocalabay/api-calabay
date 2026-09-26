const ninjaotp = require("../lib/ninjaotp");
const engineunicorn = require("../lib/engineunicorn");
const db = require("../db");

async function runTests() {
  console.log("--- TEST 1: Verification of exports and alias ---");
  console.log("ninjaotp === engineunicorn?", ninjaotp === engineunicorn);
  console.log("Type of getServices:", typeof ninjaotp.getServices);
  console.log("Type of rent:", typeof ninjaotp.rent);
  console.log("Type of getOrder:", typeof ninjaotp.getOrder);
  console.log("Type of checkSms:", typeof ninjaotp.checkSms);
  console.log("Type of cancel:", typeof ninjaotp.cancel);
  console.log("Type of resend:", typeof ninjaotp.resend);
  console.log("Type of getBalance:", typeof ninjaotp.getBalance);

  console.log("\n--- TEST 2: db.js normalizeProvider ---");
  console.log("normalizeProvider('ninjaotp'):", db.normalizeProvider("ninjaotp"));
  console.log("normalizeProvider('ninjatop'):", db.normalizeProvider("ninjatop"));
  console.log("normalizeProvider('server2'):", db.normalizeProvider("server2"));
  console.log("normalizeProvider('engineunicorn'):", db.normalizeProvider("engineunicorn"));

  console.log("\n--- TEST 3: Calling without API key ---");
  const noKeyServices = await ninjaotp.getServices();
  console.log("Result with no key:", noKeyServices);
  console.log("Last error with no key:", ninjaotp.getLastError());

  console.log("\n--- TEST 4: Calling with test invalid key to verify Ninja OTP API endpoint response parsing ---");
  process.env.NINJAOTP_API_KEY = "nk_dummy_key_for_testing_12345";
  const dummyServices = await ninjaotp.getServices(true);
  console.log("Result with dummy key:", dummyServices);
  console.log("Last error with dummy key:", ninjaotp.getLastError());

  const balance = await ninjaotp.getBalance();
  console.log("Balance result with dummy key:", balance);
  console.log("Last error after getBalance:", ninjaotp.getLastError());

  console.log("\n--- All checks completed successfully! ---");
}

runTests().catch(console.error);
