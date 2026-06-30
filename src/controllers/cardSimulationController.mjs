// controllers/cardSimulationController.mjs
import pool from "../db.mjs";

const PAGE_LINES  = 31;
const LEFT_LINES  = 15;
const RIGHT_LINES = 16; // unused directly but documents the split

/**
 * Walks a chronological list of transactions and figures out, for every
 * rate-sized "line", which transaction's date completed it.
 * Also returns any leftover partial progress toward the next line.
 */
function buildLineProgress(transactions, rate) {
  const lineDates = [];
  let cumulative = 0;
  let nextThreshold = rate;

  for (const tx of transactions) {
    cumulative += Number(tx.amount);
    while (cumulative >= nextThreshold - 0.0001) {
      lineDates.push(tx.transaction_date);
      nextThreshold += rate;
    }
  }

  const linesCompleted   = lineDates.length;
  const partialProgress  = +(cumulative - linesCompleted * rate).toFixed(2);

  return {
    lineDates,
    total: +cumulative.toFixed(2),
    linesCompleted,
    partialProgress,
  };
}

function buildCard({ rate, depositTxs, withdrawalTxs, account }) {
  const deposits    = buildLineProgress(depositTxs, rate);
  const withdrawals = buildLineProgress(withdrawalTxs, rate);

  const pageCapacity = +(rate * PAGE_LINES).toFixed(2);

  // ── Withdrawal side: how many pages are fully consumed (stamped) ──
  const totalWithdrawn        = withdrawals.total;
  const completedPages        = Math.floor(totalWithdrawn / pageCapacity);
  const advanceOnCurrentPage  = +(totalWithdrawn - completedPages * pageCapacity).toFixed(2);

  // ── Deposit side: how many lines have actually been staked ──
  const linesStakedGlobal = deposits.linesCompleted;
  const pagesForDeposits  = Math.max(1, Math.ceil(linesStakedGlobal / PAGE_LINES) || 1);
  const pagesForWithdrawals = completedPages + (advanceOnCurrentPage > 0 ? 1 : 0);
  const totalPages = Math.max(pagesForDeposits, pagesForWithdrawals, 1);

  const pages = [];

  for (let p = 1; p <= totalPages; p++) {
    const startGlobal = (p - 1) * PAGE_LINES;
    const linesStakedOnPage = Math.min(PAGE_LINES, Math.max(0, linesStakedGlobal - startGlobal));

    // build the 31 individual lines for this page
    const lines = [];
    for (let i = 0; i < PAGE_LINES; i++) {
      const globalIndex = startGlobal + i;
      const filled = globalIndex < linesStakedGlobal;
      const isPending = !filled && globalIndex === linesStakedGlobal && deposits.partialProgress > 0;

      lines.push({
        lineNumber: i + 1,
        side: i < LEFT_LINES ? "left" : "right",
        sideIndex: i < LEFT_LINES ? i + 1 : i - LEFT_LINES + 1,
        amount: rate,
        filled,
        date: filled ? deposits.lineDates[globalIndex] : null,
        pending: isPending,
        pendingAmount: isPending ? deposits.partialProgress : 0,
        pendingPercent: isPending ? Math.round((deposits.partialProgress / rate) * 100) : 0,
      });
    }

    // withdrawal status for this page
    let status, withdrawnOnPage, commissionTaken, balanceOnPage, payoutToCustomer;

    if (p <= completedPages) {
      // Fully cashed out — stamped, commission line taken
      status           = "completed";
      withdrawnOnPage  = pageCapacity;
      commissionTaken  = rate;
      payoutToCustomer = +(rate * 30).toFixed(2);
      balanceOnPage    = 0;
    } else if (p === completedPages + 1 && advanceOnCurrentPage > 0) {
      // Partially cashed out — advance, commission untouched
      status           = "advance";
      withdrawnOnPage  = advanceOnCurrentPage;
      commissionTaken  = 0;
      payoutToCustomer = advanceOnCurrentPage;
      balanceOnPage    = +(pageCapacity - advanceOnCurrentPage).toFixed(2);
    } else {
      // Not touched by withdrawals yet
      status           = "open";
      withdrawnOnPage  = 0;
      commissionTaken  = 0;
      payoutToCustomer = 0;
      balanceOnPage    = pageCapacity;
    }

    pages.push({
      pageNumber: p,
      pageCapacity,
      linesStaked: linesStakedOnPage,
      linesRemaining: PAGE_LINES - linesStakedOnPage,
      stakedAmount: +(linesStakedOnPage * rate).toFixed(2),
      status,                 // 'completed' | 'advance' | 'open'
      withdrawnOnPage: +withdrawnOnPage.toFixed(2),
      commissionTaken,
      balanceOnPage,
      payoutToCustomer,
      lines,
    });
  }

  return {
    account: {
      id: account.id,
      account_number: account.account_number,
      account_type: account.account_type,
      status: account.status,
      start_date: account.created_at,
      rate,
      current_balance: Number(account.balance),
    },
    rate,
    pageCapacity,
    pageLines: PAGE_LINES,
    totals: {
      totalDeposited: deposits.total,
      totalWithdrawn,
      totalLinesStaked: linesStakedGlobal,
      partialDepositProgress: deposits.partialProgress,
      completedPages,
      advanceOnCurrentPage,
      totalCommissionEarned: +(completedPages * rate).toFixed(2),
      totalPaidToCustomer: +(completedPages * rate * 30 + advanceOnCurrentPage).toFixed(2),
    },
    currentPage: completedPages + 1,
    totalPages,
    pages,
  };
}

// GET /api/accounts/:accountId/card
export const getAccountCardSimulation = async (req, res) => {
  const { accountId } = req.params;

  try {
    const accRes = await pool.query(
      `SELECT id, account_number, account_type, status, balance, daily_rate, created_at, company_id, customer_id
       FROM accounts
       WHERE id = $1 AND is_deleted = false`,
      [accountId]
    );

    if (accRes.rowCount === 0) {
      return res.status(404).json({ status: "fail", message: "Account not found" });
    }

    const account = accRes.rows[0];
    const rate = Number(account.daily_rate);

    if (!rate || rate <= 0) {
      return res.status(400).json({
        status: "fail",
        message:
          "This account has no daily rate configured — card simulation only applies to rate-based (susu) accounts.",
      });
    }

    const txRes = await pool.query(
      `SELECT amount, type, transaction_date
       FROM transactions
       WHERE account_id = $1
         AND is_deleted = false
         AND type IN ('deposit', 'withdrawal')
         AND status IN ('approved', 'completed')
       ORDER BY transaction_date ASC, created_at ASC`,
      [accountId]
    );

    const depositTxs    = txRes.rows.filter((t) => t.type === "deposit");
    const withdrawalTxs = txRes.rows.filter((t) => t.type === "withdrawal");

    const card = buildCard({ rate, depositTxs, withdrawalTxs, account });

    return res.status(200).json({ status: "success", data: card });
  } catch (error) {
    console.error("getAccountCardSimulation error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};