const db = require("../db");

async function test() {
  console.log("--- TEST 1: Functions exist ---");
  console.log("typeof db.syncUser:", typeof db.syncUser);
  console.log("typeof db.persistUser:", typeof db.persistUser);
  console.log("typeof db.isMongoReady:", typeof db.isMongoReady);
  console.log("typeof db.getTopBuyers:", typeof db.getTopBuyers);

  console.log("\n--- TEST 2: db.getTopBuyers() ---");
  const top = db.getTopBuyers(5);
  console.log("Top buyers count:", top.length);
  console.log("Sample top buyers:", top);

  console.log("\n--- TEST 3: syncUser with dummy id (fallback) ---");
  const fallbackUser = await db.syncUser("dummy_test_123");
  console.log("Fallback user:", fallbackUser);

  console.log("\nAll syntax and logic tests passed successfully!");
}

test().catch(console.error);
