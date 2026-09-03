/**
 * seed-db.js — load the fixture data into MongoDB.
 *
 * Run with:  node seed-db.js
 *
 * Safe to re-run. It wipes the business collections and reloads them, which is
 * what you want in development: a known starting state every time.
 *
 * It deliberately does NOT touch agentruns or toolcalls — those are your
 * history, and wiping them every time you reset test data would throw away the
 * observability we just built.
 */

require("dotenv").config();
const { connectDB, disconnectDB } = require("./src/db/connection");
const {
  Customer,
  Order,
  Invoice,
  Refund,
  Escalation,
} = require("./src/db/models");
const seed = require("./src/data/seed");

async function main() {
  const ok = await connectDB();
  if (!ok) {
    console.error(
      "\nCould not connect to MongoDB.\n" +
        "Is the container running?   docker ps\n" +
        "Start it with:              docker start helpdesk-mongo\n"
    );
    process.exit(1);
  }

  console.log("\nClearing business collections...");
  await Promise.all([
    Customer.deleteMany({}),
    Order.deleteMany({}),
    Invoice.deleteMany({}),
    Refund.deleteMany({}),
    Escalation.deleteMany({}),
  ]);

  console.log("Inserting fixtures...");
  await Customer.insertMany(seed.CUSTOMERS);
  await Order.insertMany(seed.ORDERS);
  await Invoice.insertMany(seed.INVOICES);

  console.log("\nSeeded:");
  console.log(`  customers : ${await Customer.countDocuments()}`);
  console.log(`  orders    : ${await Order.countDocuments()}`);
  console.log(`  invoices  : ${await Invoice.countDocuments()}`);
  console.log(`  refunds   : ${await Refund.countDocuments()} (starts empty)`);
  console.log(`  escalations: ${await Escalation.countDocuments()} (starts empty)`);

  // Prove the duplicate-charge fixture survived, since the assignment's worked
  // example depends on it.
  const dupes = await Invoice.aggregate([
    { $group: { _id: { o: "$orderId", a: "$amount", d: "$issuedAt" }, n: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  console.log(
    `\n  duplicate charge present: ${dupes.length > 0 ? "yes — " + dupes[0].ids.join(" + ") : "NO (worked example will not run)"}`
  );

  await disconnectDB();
  console.log("\nDone.\n");
}

main().catch(async (err) => {
  console.error("\nSeed failed:", err.message);
  await disconnectDB();
  process.exit(1);
});
