const axios = require("axios");
const config = require("../config");

const apiKey = config.HERO_SMS_API_KEY;
const baseURL = config.HERO_SMS_API_URL;

async function test() {
  try {
    console.log("Checking balance...");
    const resBal = await axios.get(`${baseURL}/stubs/handler_api.php`, {
      params: { action: "getBalance", api_key: apiKey },
    });
    console.log("Balance:", resBal.data);

    console.log("\nChecking getPrices for wa (Indonesia country 6)...");
    const resPrices = await axios.get(`${baseURL}/stubs/handler_api.php`, {
      params: { action: "getPrices", service: "wa", country: "6", api_key: apiKey },
    });
    console.log("Prices wa country 6:", JSON.stringify(resPrices.data, null, 2));

    console.log("\nChecking getPrices with verification=true or call...");
    const resPricesVerif = await axios.get(`${baseURL}/stubs/handler_api.php`, {
      params: { action: "getPrices", service: "wa", country: "6", verification: "true", api_key: apiKey },
    });
    console.log("Prices wa country 6 verification=true:", JSON.stringify(resPricesVerif.data, null, 2));

    console.log("\nChecking getServicesList...");
    const resSvc = await axios.get(`${baseURL}/stubs/handler_api.php`, {
      params: { action: "getServicesList", country: "6", api_key: apiKey },
    });
    console.log("Services sample (first 3):", resSvc.data?.services?.slice(0, 3));
    
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
}

test();
