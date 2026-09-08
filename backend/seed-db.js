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
  AgentRun,
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

  // ---- ABANDONED APPROVALS ----------------------------------------------
  //
  // Run history is deliberately preserved (see the note at the top) - it is
  // the observability we built and wiping it every reset would throw that
  // away.
  //
  // But a run left in `awaiting_confirmation` is not history, it is an OPEN
  // TASK. Test suites deliberately pause on $2,400 refunds to prove the
  // policy works, and never approve them - so every safety run left two more
  // items sitting in the operator's queue, referring to business data this
  // very script just deleted.
  //
  // The queue is a to-do list for a human. A to-do list that fills with items
  // nobody can action is one an operator stops reading, and then a real
  // approval waits just as long as if there were no queue at all.
  const abandoned = await AgentRun.updateMany(
    { status: "awaiting_confirmation" },
    { $set: { status: "expired", expiredAt: new Date() } }
  );
  if (abandoned.modifiedCount > 0) {
    console.log(
      `  approvals : ${abandoned.modifiedCount} abandoned one(s) expired ` +
        `(they pointed at data this reset just replaced)`
    );
  }

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
