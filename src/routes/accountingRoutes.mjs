import express from "express";
import {
  // Chart of accounts
  getChartOfAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  deleteAccount,
  // Journal entries
  getJournalEntries,
  createManualJournalEntry,
  // General ledger
  getGeneralLedger,
  // Reports
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  // Periods
  getPeriods,
  createPeriod,
  closePeriod,
} from "../controllers/accountingController.mjs";

const accountingRoutes = express.Router({ mergeParams: true });
// All routes are mounted at /api/accounting/:companyId/...

// ── Chart of accounts ─────────────────────────────────────────
accountingRoutes.get   ("/accounts",            getChartOfAccounts);
accountingRoutes.get   ("/accounts/:accountId", getAccountById);
accountingRoutes.post  ("/accounts",            createAccount);
accountingRoutes.patch ("/accounts/:accountId", updateAccount);
accountingRoutes.delete("/accounts/:accountId", deleteAccount);

// ── Journal entries ───────────────────────────────────────────
accountingRoutes.get ("/journal",     getJournalEntries);
accountingRoutes.post("/journal",     createManualJournalEntry);

// ── General ledger ────────────────────────────────────────────
accountingRoutes.get("/ledger",        getGeneralLedger);

// ── Financial reports ─────────────────────────────────────────
accountingRoutes.get("/reports/trial-balance",  getTrialBalance);
accountingRoutes.get("/reports/profit-loss",    getProfitAndLoss);
accountingRoutes.get("/reports/balance-sheet",  getBalanceSheet);

// ── Periods ───────────────────────────────────────────────────
accountingRoutes.get  ("/periods",             getPeriods);
accountingRoutes.post ("/periods",             createPeriod);
accountingRoutes.patch("/periods/:periodId/close", closePeriod);

export default accountingRoutes;

// ─────────────────────────────────────────────────────────────
// In your main app.mjs / index.mjs, mount like this:
//
//   import accountingaccountingRoutes from "./routes/accountingRoutes.mjs";
//   app.use("/api/accounting/:companyId", accountingaccountingRoutes);
// ─────────────────────────────────────────────────────────────
