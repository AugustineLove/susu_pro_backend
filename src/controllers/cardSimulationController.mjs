// controllers/cardSimulationController.mjs
import pool from "../db.mjs";

const PAGE_LINES = 31;
const LEFT_LINES = 15;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Rate timeline ────────────────────────────────────────────────────────
// Builds an ascending list of { startDate, rate } periods from the account's
// daily_rate change history. startDate === null means "from the beginning".
function buildRatePeriods(rateHistoryRows, fallbackRate) {
  if (!rateHistoryRows.length) {
    return [{ startDate: null, rate: Number(fallbackRate) }];
  }

  const first = rateHistoryRows[0];
  const initialRate = first.previous_rate != null ? Number(first.previous_rate) : Number(first.new_rate);

  const periods = [{ startDate: null, rate: initialRate }];
  for (const row of rateHistoryRows) {
    periods.push({ startDate: row.effective_date, rate: Number(row.new_rate) });
  }
  return periods;
}

function getRateForDate(periods, date) {
  const t = new Date(date).getTime();
  let applicable = periods[0].rate;
  for (const period of periods) {
    if (period.startDate === null) {
      applicable = period.rate;
      continue;
    }
    if (new Date(period.startDate).getTime() <= t) {
      applicable = period.rate;
    } else {
      break;
    }
  }
  return applicable;
}

// ── Core simulation ──────────────────────────────────────────────────────
// Walks ALL transactions (deposits + withdrawals) in one true chronological
// stream and builds up "pages" as living objects. This is what lets a
// withdrawal correctly target the earliest still-open page while deposits
// keep filling a later page independently, and lets rate changes force a
// clean page break.
function simulateCard(transactions, ratePeriods) {
  const pages = [];
  const warnings = [];

  const lastPage = () => (pages.length ? pages[pages.length - 1] : null);

  const openNewPage = (rate, startDate) => {
    const page = {
      pageNumber: pages.length + 1,
      rate,
      pageCapacity: round2(rate * PAGE_LINES),
      stakedAmount: 0,
      withdrawnAmount: 0,
      commissionTaken: 0,
      status: "open", // 'open' | 'advance' | 'completed' — 'advance' derived at finalize time
      closedEarly: false,
      overdrawn: false,
      startDate,
      lineDates: [], // lineDates[i] = date the (i+1)-th line was completed
      partialAmount: 0,
      partialDate: null,
    };
    pages.push(page);
    return page;
  };

  // A page accepts new deposits only if it exists, isn't completed, and has room.
  const currentDepositPage = (rate) => {
    const p = lastPage();
    if (!p) return null;
    if (p.status === "completed") return null;
    if (p.stakedAmount >= p.pageCapacity - 0.0001) return null;
    if (p.rate !== rate) return null; // rate changed → force new page
    return p;
  };

  const earliestOpenPage = () => pages.find((p) => p.status !== "completed") || null;

  for (const tx of transactions) {
    const rate = getRateForDate(ratePeriods, tx.transaction_date);
    const amount = round2(Number(tx.amount));
    if (!amount || amount <= 0) continue;

    if (tx.type === "deposit") {
      let remaining = amount;
      while (remaining > 0.0001) {
        let page = currentDepositPage(rate);
        if (!page) page = openNewPage(rate, tx.transaction_date);

        const spaceLeft = round2(page.pageCapacity - page.stakedAmount);
        let chunk = round2(Math.min(remaining, spaceLeft));

        // Fill line-by-line so each line gets an accurate completion date.
        while (chunk > 0.0001) {
          const filledLines = Math.floor((page.stakedAmount + 0.0001) / page.rate);
          const lineFillSoFar = round2(page.stakedAmount - filledLines * page.rate);
          const spaceInLine = round2(page.rate - lineFillSoFar);
          const fillNow = round2(Math.min(chunk, spaceInLine));

          page.stakedAmount = round2(page.stakedAmount + fillNow);
          chunk = round2(chunk - fillNow);

          const nowFilledLines = Math.floor((page.stakedAmount + 0.0001) / page.rate);
          if (nowFilledLines > filledLines) {
            page.lineDates[nowFilledLines - 1] = tx.transaction_date;
          }
        }

        const filledLinesNow = Math.floor((page.stakedAmount + 0.0001) / page.rate);
        page.partialAmount = round2(page.stakedAmount - filledLinesNow * page.rate);
        page.partialDate = page.partialAmount > 0.0001 ? tx.transaction_date : null;

        remaining = round2(remaining - (spaceLeft > 0 ? Math.min(remaining, spaceLeft) : 0));
        if (spaceLeft <= 0.0001) {
          // defensive: force page rotation if something upstream left 0 space
          remaining = round2(remaining);
        }
      }
    } else if (tx.type === "withdrawal") {
      let remaining = amount;
      let safety = 0;

      while (remaining > 0.0001 && safety < 500) {
        safety++;
        let page = earliestOpenPage();
        if (!page) page = openNewPage(rate, tx.transaction_date);

        // Nothing meaningfully staked (not even one full line) — this page
        // can't be closed out. Treat as an overdraft against it and stop,
        // rather than looping forever.
        if (page.stakedAmount < page.rate - 0.0001) {
          page.withdrawnAmount = round2(page.withdrawnAmount + remaining);
          page.overdrawn = true;
          warnings.push(
            `Page ${page.pageNumber}: withdrawal recorded (${remaining}) exceeds what has been staked on this page — please verify transaction history.`
          );
          remaining = 0;
          break;
        }

        // Closure trigger: cash withdrawn reaches (staked − one line),
        // i.e. everything except the commission line.
        const closeThreshold = round2(page.stakedAmount - page.rate);
        const payableBeforeClose = round2(closeThreshold - page.withdrawnAmount);
        const payNow = round2(Math.min(remaining, Math.max(payableBeforeClose, 0)));

        page.withdrawnAmount = round2(page.withdrawnAmount + payNow);
        remaining = round2(remaining - payNow);

        if (round2(page.withdrawnAmount) >= closeThreshold - 0.0001) {
          page.status = "completed";
          page.commissionTaken = page.rate;
          page.closedEarly = page.stakedAmount < page.pageCapacity - 0.0001;
          page.closedAt = tx.transaction_date;
          // loop continues if remaining > 0 — rolls onto the next open page
        } else {
          break; // partial draw, page stays open — done with this transaction
        }
      }
    }
  }

  return { pages, warnings };
}

// ── Turn a raw simulated page into the API/UI shape ─────────────────────
function finalizePage(page) {
  const linesStaked = page.lineDates.length;
  const isCompleted = page.status === "completed";
  const rate = page.rate;

  const withdrawnLinesCount = isCompleted
    ? linesStaked
    : Math.min(linesStaked, Math.floor(page.withdrawnAmount / rate + 0.0001));

  const partialWithdrawnAmount = isCompleted
    ? 0
    : round2(page.withdrawnAmount - withdrawnLinesCount * rate);

  const commissionLineNumber = isCompleted && linesStaked > 0 ? linesStaked : null;

  const lines = [];
  for (let i = 0; i < PAGE_LINES; i++) {
    const lineNumber = i + 1;
    const isStakedLine = lineNumber <= linesStaked;
    const isDepositingLine = !isStakedLine && lineNumber === linesStaked + 1 && page.partialAmount > 0.0001;

    let status;
    if (isCompleted) {
      if (lineNumber > linesStaked) status = "void"; // abandoned — page closed before this line was ever staked
      else if (lineNumber === commissionLineNumber) status = "commission";
      else status = "withdrawn";
    } else if (lineNumber <= withdrawnLinesCount) {
      status = "withdrawn";
    } else if (lineNumber === withdrawnLinesCount + 1 && partialWithdrawnAmount > 0.0001) {
      status = "partial-withdrawn";
    } else if (isStakedLine) {
      status = "staked";
    } else if (isDepositingLine) {
      status = "depositing";
    } else {
      status = "open";
    }

    lines.push({
      lineNumber,
      side: i < LEFT_LINES ? "left" : "right",
      sideIndex: i < LEFT_LINES ? i + 1 : i - LEFT_LINES + 1,
      amount: rate,
      status,
      date: isStakedLine ? page.lineDates[i] || null : null,
      pendingAmount:
        status === "depositing" ? page.partialAmount : status === "partial-withdrawn" ? partialWithdrawnAmount : 0,
      pendingPercent:
        status === "depositing"
          ? Math.round((page.partialAmount / rate) * 100)
          : status === "partial-withdrawn"
          ? Math.round((partialWithdrawnAmount / rate) * 100)
          : 0,
    });
  }

  return {
    pageNumber: page.pageNumber,
    rate,
    pageCapacity: page.pageCapacity,
    linesStaked,
    linesRemaining: PAGE_LINES - linesStaked,
    stakedAmount: page.stakedAmount,
    status: isCompleted ? "completed" : page.withdrawnAmount > 0 ? "advance" : "open",
    closedEarly: !!page.closedEarly,
    overdrawn: !!page.overdrawn,
    withdrawnOnPage: round2(page.withdrawnAmount),
    commissionTaken: round2(page.commissionTaken),
    balanceOnPage: isCompleted ? 0 : round2(page.stakedAmount - page.withdrawnAmount),
    payoutToCustomer: isCompleted ? round2(page.stakedAmount - page.commissionTaken) : round2(page.withdrawnAmount),
    lines,
  };
}

// GET /api/accounts/:accountId/card-simulate
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
    const currentRate = Number(account.daily_rate);

    if (!currentRate || currentRate <= 0) {
      return res.status(400).json({
        status: "fail",
        message:
          "This account has no daily rate configured — card simulation only applies to rate-based (susu) accounts.",
      });
    }

    // Single chronologically-sorted stream of deposits + withdrawals.
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

    // Rate change history — daily_rate only, ascending.
    const rateHistoryRes = await pool.query(
      `SELECT effective_date, previous_rate, new_rate
       FROM account_rate_changes
       WHERE account_id = $1 AND rate_type = 'daily_rate'
       ORDER BY effective_date ASC, created_at ASC`,
      [accountId]
    );

    const ratePeriods = buildRatePeriods(rateHistoryRes.rows, currentRate);
    const { pages: rawPages, warnings } = simulateCard(txRes.rows, ratePeriods);

    const pages = rawPages.length ? rawPages.map(finalizePage) : [];

    if (pages.length === 0) {
      // No transactions yet — show one empty page at the current rate.
      pages.push(
        finalizePage({
          pageNumber: 1,
          rate: currentRate,
          pageCapacity: round2(currentRate * PAGE_LINES),
          stakedAmount: 0,
          withdrawnAmount: 0,
          commissionTaken: 0,
          status: "open",
          closedEarly: false,
          overdrawn: false,
          lineDates: [],
          partialAmount: 0,
        })
      );
    }

    const totalDeposited = round2(
      txRes.rows.filter((t) => t.type === "deposit").reduce((s, t) => s + Number(t.amount), 0)
    );
    const totalWithdrawn = round2(
      txRes.rows.filter((t) => t.type === "withdrawal").reduce((s, t) => s + Number(t.amount), 0)
    );
    const completedPages = pages.filter((p) => p.status === "completed").length;
    const totalCommissionEarned = round2(pages.reduce((s, p) => s + p.commissionTaken, 0));
    const totalPaidToCustomer = round2(pages.reduce((s, p) => s + p.payoutToCustomer, 0));

    const firstOpenIndex = pages.findIndex((p) => p.status !== "completed");
    const currentPage = firstOpenIndex >= 0 ? firstOpenIndex + 1 : pages.length;

    return res.status(200).json({
      status: "success",
      data: {
        account: {
          id: account.id,
          account_number: account.account_number,
          account_type: account.account_type,
          status: account.status,
          start_date: account.created_at,
          rate: currentRate, // account's CURRENT rate — individual pages may differ, see page.rate
          current_balance: Number(account.balance),
        },
        pageLines: PAGE_LINES,
        totals: {
          totalDeposited,
          totalWithdrawn,
          completedPages,
          totalCommissionEarned,
          totalPaidToCustomer,
        },
        currentPage,
        totalPages: pages.length,
        warnings,
        pages,
      },
    });
  } catch (error) {
    console.error("getAccountCardSimulation error:", error.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};