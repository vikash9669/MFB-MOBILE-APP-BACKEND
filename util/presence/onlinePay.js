// Online pay — ₹10 for every hour a rider is online, credited once a day.
//
// Agreed rules (RIDER_ONLINE_PAY.md):
//   * all online time counts, shift or no shift, on top of delivery earnings;
//   * pro-rata per whole minute: 45 min = ₹7.50, 12 h = ₹120;
//   * credited after the IST day ends, with a top-up if offline data for that
//     day syncs later.
//
// IDEMPOTENT BY CONSTRUCTION. store_rider_online_pay holds one row per rider
// per day with what has already been paid. Every run recomputes what the day is
// worth and credits only the difference, inside one transaction that also
// locks the rider's row. Running the job twice, on two servers, or after a
// crash between the wallet write and the ledger write cannot pay a minute twice
// — the wallet entry, the balance and the ledger commit together or not at all.
const { QueryTypes } = require("sequelize");
const sequelize = require("../database");
const { onlineMinutesIn } = require("./spans");
const { spansBetween, evaluateRecentShifts } = require("./shifts");
const { presenceConfig, istDateOf, istDayBounds, istAddDays } = require("./config");

/** Paise owed for whole online minutes at a rate in rupees per hour. */
const paiseFor = (minutes, perHour) => Math.round((minutes * perHour * 100) / 60);

const rupees = (paise) => (paise / 100).toFixed(2);

/** "12h 5m" — how the wallet line describes the time. */
const hoursLabel = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};

/** "14 Sept" for a YYYY-MM-DD date. */
const dayLabel = (date) =>
  new Date(`${date}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });

/**
 * Settles one rider's online pay for one IST day.
 *
 * Returns { dpId, date, onlineMin, owedPaise, creditedPaise, txnId }.
 */
async function settleDay(dpId, date, { nowMs = Date.now() } = {}) {
  const cfg = presenceConfig();
  const { startMs, endMs } = istDayBounds(date);

  const result = await sequelize.transaction(async (transaction) => {
    // Same lock ingest takes, so the spans read here cannot be halfway through
    // being rewritten by an upload for this rider.
    await sequelize.query("SELECT `user_id` FROM `store_users` WHERE `user_id` = :dpId FOR UPDATE", {
      replacements: { dpId },
      type: QueryTypes.SELECT,
      transaction,
    });

    const spans = await spansBetween(dpId, startMs, endMs, transaction);
    const onlineMin = onlineMinutesIn(spans, startMs, endMs);
    const owedPaise = paiseFor(onlineMin, cfg.payPerHour);

    let [ledger] = await sequelize.query(
      "SELECT * FROM `store_rider_online_pay` WHERE `dp_id` = :dpId AND `pay_date` = :date FOR UPDATE",
      { replacements: { dpId, date }, type: QueryTypes.SELECT, transaction }
    );
    if (!ledger) {
      if (onlineMin === 0) {
        return { dpId, date, onlineMin, owedPaise, creditedPaise: 0, txnId: null };
      }
      await sequelize.query(
        `INSERT INTO \`store_rider_online_pay\`
           (\`dp_id\`, \`pay_date\`, \`online_min\`, \`rate_per_hour\`, \`paid_paise\`, \`updated_ms\`)
         VALUES (:dpId, :date, 0, :rate, 0, :now)`,
        { replacements: { dpId, date, rate: cfg.payPerHour, now: nowMs }, type: QueryTypes.INSERT, transaction }
      );
      [ledger] = await sequelize.query(
        "SELECT * FROM `store_rider_online_pay` WHERE `dp_id` = :dpId AND `pay_date` = :date FOR UPDATE",
        { replacements: { dpId, date }, type: QueryTypes.SELECT, transaction }
      );
    }

    const paidPaise = Number(ledger.paid_paise);
    const creditPaise = owedPaise - paidPaise;

    // Pay only ever goes up: spans only grow. A smaller number here would mean
    // data was deleted by hand, which is not something to claw back silently.
    if (creditPaise <= 0) {
      if (Number(ledger.online_min) !== onlineMin && onlineMin > Number(ledger.online_min)) {
        await sequelize.query(
          "UPDATE `store_rider_online_pay` SET `online_min` = :onlineMin, `updated_ms` = :now WHERE `pay_id` = :id",
          { replacements: { onlineMin, now: nowMs, id: ledger.pay_id }, type: QueryTypes.UPDATE, transaction }
        );
      }
      return { dpId, date, onlineMin, owedPaise, creditedPaise: 0, txnId: null };
    }

    const topUp = paidPaise > 0;
    const title = topUp
      ? `Online time top-up · ${dayLabel(date)}`
      : `Online time pay · ${dayLabel(date)}`;
    const description = topUp
      ? `Late-synced online time: now ${hoursLabel(onlineMin)} at ₹${cfg.payPerHour}/hour`
      : `${hoursLabel(onlineMin)} online at ₹${cfg.payPerHour}/hour`;

    const [txnId] = await sequelize.query(
      `INSERT INTO \`store_delivery_wallet_txns\`
         (\`dp_id\`, \`type\`, \`direction\`, \`amount\`, \`title\`, \`description\`, \`ref_order_id\`, \`status\`, \`created_at\`)
       VALUES (:dpId, 'earning', 'credit', :amount, :title, :description, NULL, 'settled', :createdAt)`,
      {
        replacements: { dpId, amount: rupees(creditPaise), title, description, createdAt: new Date(nowMs) },
        type: QueryTypes.INSERT,
        transaction,
      }
    );
    await sequelize.query(
      "UPDATE `store_users` SET `dp_wallet_balance` = `dp_wallet_balance` + :amount WHERE `user_id` = :dpId",
      { replacements: { amount: rupees(creditPaise), dpId }, type: QueryTypes.UPDATE, transaction }
    );
    const txnIds = [ledger.txn_ids, txnId].filter(Boolean).join(",").slice(0, 255);
    await sequelize.query(
      `UPDATE \`store_rider_online_pay\`
          SET \`online_min\` = :onlineMin, \`paid_paise\` = :owed, \`rate_per_hour\` = :rate,
              \`txn_ids\` = :txnIds, \`updated_ms\` = :now
        WHERE \`pay_id\` = :id`,
      {
        replacements: { onlineMin, owed: owedPaise, rate: cfg.payPerHour, txnIds, now: nowMs, id: ledger.pay_id },
        type: QueryTypes.UPDATE,
        transaction,
      }
    );
    return { dpId, date, onlineMin, owedPaise, creditedPaise: creditPaise, txnId, title, description };
  });

  if (result.creditedPaise > 0) {
    // After commit: a notification failing must not undo a payment.
    try {
      const { notifyPartner } = require("../deliveryNotify");
      await notifyPartner(dpId, {
        category: "payments",
        icon: "account_balance_wallet",
        title: `₹${rupees(result.creditedPaise)} credited for online time`,
        body: result.description,
        data: { type: "online_pay", date },
      });
    } catch (err) {
      console.log("MFB ~ online pay ~ notify ~", err.message);
    }
  }
  return result;
}

/** Riders with any online time overlapping [fromMs, toMs). */
async function ridersOnlineBetween(fromMs, toMs) {
  const rows = await sequelize.query(
    `SELECT DISTINCT \`dp_id\` FROM \`store_rider_presence_spans\`
      WHERE \`end_ms\` > :from AND \`start_ms\` < :to AND \`end_ms\` > \`start_ms\`
        AND (\`end_reason\` IS NULL OR \`end_reason\` <> 'blackout')`,
    { replacements: { from: fromMs, to: toMs }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => Number(r.dp_id));
}

/**
 * One pass: settle every ended day inside the backfill window, then refresh
 * shift completion. Returns what was credited.
 */
async function runOnlinePayOnce({ nowMs = Date.now() } = {}) {
  const cfg = presenceConfig();
  const credited = [];
  if (cfg.payEnabled) {
    const today = istDateOf(nowMs);
    const days = Math.ceil(cfg.backfillMs / 86_400_000) + 1;
    for (let back = days; back >= 1; back -= 1) {
      const date = istAddDays(today, -back);
      const { startMs, endMs } = istDayBounds(date);
      // Give the last uploads of the day time to land before paying it.
      if (nowMs < endMs + cfg.paySettleDelayMs) continue;
      for (const dpId of await ridersOnlineBetween(startMs, endMs)) {
        try {
          const r = await settleDay(dpId, date, { nowMs });
          if (r.creditedPaise > 0) credited.push(r);
        } catch (err) {
          // One rider's failure must not stop everyone else being paid.
          console.log(`MFB ~ online pay ~ dp ${dpId} ${date} ~`, err.message);
        }
      }
    }
    if (credited.length) {
      const total = credited.reduce((t, r) => t + r.creditedPaise, 0);
      console.log(`MFB ~ online pay ~ credited ₹${rupees(total)} across ${credited.length} rider-day(s)`);
    }
  }
  const shiftsChanged = await evaluateRecentShifts({ nowMs }).catch((err) => {
    console.log("MFB ~ shift completion ~", err.message);
    return 0;
  });
  return { credited, shiftsChanged };
}

/** Today's online time and what it will be worth — for the app, before payout. */
async function accruedToday(dpId, { nowMs = Date.now() } = {}) {
  const cfg = presenceConfig();
  const { startMs } = istDayBounds(istDateOf(nowMs));
  const spans = await spansBetween(dpId, startMs, nowMs);
  const onlineMin = onlineMinutesIn(spans, startMs, nowMs);
  return { online_min: onlineMin, amount: Number(rupees(paiseFor(onlineMin, cfg.payPerHour))), rate_per_hour: cfg.payPerHour };
}

/** Credited online pay in [fromDate, toDate] (inclusive IST dates). */
async function paidBetween(dpId, fromDate, toDate) {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(\`paid_paise\`), 0) AS \`paise\`, COALESCE(SUM(\`online_min\`), 0) AS \`minutes\`
       FROM \`store_rider_online_pay\`
      WHERE \`dp_id\` = :dpId AND \`pay_date\` BETWEEN :fromDate AND :toDate`,
    { replacements: { dpId, fromDate, toDate }, type: QueryTypes.SELECT }
  );
  return { amount: Number(rupees(Number(row?.paise || 0))), online_min: Number(row?.minutes || 0) };
}

/** Runs the job on a timer. Logged, never thrown. */
function startOnlinePayJob() {
  const cfg = presenceConfig();
  let warned = false;
  const tick = () =>
    runOnlinePayOnce().catch((err) => {
      if (warned) return;
      warned = true;
      console.log("MFB ~ online pay job idle: " + (err.original?.sqlMessage || err.message));
    });
  tick();
  const timer = setInterval(tick, cfg.jobEveryMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  paiseFor,
  settleDay,
  runOnlinePayOnce,
  accruedToday,
  paidBetween,
  startOnlinePayJob,
  ridersOnlineBetween,
};
