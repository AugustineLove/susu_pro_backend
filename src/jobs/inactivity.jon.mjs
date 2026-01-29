import cron from "node-cron";
import pool from "../db.mjs";

cron.schedule("0 2 * * *", async () => {
  console.log("⏰ Running inactivity cron job...");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* 1️⃣ Inactivate stale accounts */
    await client.query(`
      UPDATE accounts
      SET status = 'Inactive',
          inactive_at = NOW()
      WHERE status = 'Active'
        AND last_activity_at IS NOT NULL
        AND last_activity_at < NOW() - INTERVAL '30 days'
    `);

    /* 2️⃣ Inactivate customers with no active accounts */
    await client.query(`
      UPDATE customers c
      SET status = 'Inactive'
      WHERE NOT EXISTS (
        SELECT 1 FROM accounts a
        WHERE a.customer_id = c.id
          AND a.status = 'Active'
      )
      AND EXISTS (
        SELECT 1 FROM accounts a
        WHERE a.customer_id = c.id
          AND a.inactive_at <= NOW() - INTERVAL '20 days'
      )
    `);

    await client.query("COMMIT");
    console.log("✅ Inactivity cron completed");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Inactivity cron failed:", err);
  } finally {
    client.release();
  }
});
