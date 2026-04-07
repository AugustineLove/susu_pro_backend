/**
 * Day-End Routes
 * Mount at:  app.use('/api/day-end', dayEndRoutes)
 */

import express from "express";
import {
  getDayEndSummary,
  getTellerReconciliation,
  getLoanOfficerDayEnd,
  getFinancialDayEnd,
  getSalesDayEnd,
  getHRDayEnd,
  closeDay,
  getDayEndAuditTrail,
  getDayEndStatus,
  getDayEndLogs,
  getSingleDayEnd,
} from "../controllers/dayEndController.mjs";

const dayEndRouter = express.Router();

// ── Live status widget (all roles) ──────────────────────────────────────────
// GET /api/day-end/:companyId/status
dayEndRouter.get("/:companyId/status", getDayEndStatus);

// ── Master summary  (CEO / Manager / Accountant) ────────────────────────────
// GET /api/day-end/:companyId/summary?date=YYYY-MM-DD
dayEndRouter.get("/:companyId/summary", getDayEndSummary);

// ── Teller float reconciliation  (Teller / Manager) ─────────────────────────
// GET /api/day-end/:companyId/teller-reconciliation?date=YYYY-MM-DD&teller_id=
dayEndRouter.get("/:companyId/teller-reconciliation", getTellerReconciliation);

// ── Loan officer report  (Loan Officer / Manager) ────────────────────────────
// GET /api/day-end/:companyId/loan-report?date=YYYY-MM-DD&officer_id=
dayEndRouter.get("/:companyId/loan-report", getLoanOfficerDayEnd);

// ── Financial / accountant close  (Accountant / CEO) ─────────────────────────
// GET /api/day-end/:companyId/financial-close?date=YYYY-MM-DD
dayEndRouter.get("/:companyId/financial-close", getFinancialDayEnd);

// ── Sales manager report  (Sales Manager / CEO) ──────────────────────────────
// GET /api/day-end/:companyId/sales-report?date=YYYY-MM-DD
dayEndRouter.get("/:companyId/sales-report", getSalesDayEnd);

// ── HR report  (HR / Manager) ────────────────────────────────────────────────
// GET /api/day-end/:companyId/hr-report?date=YYYY-MM-DD
dayEndRouter.get("/:companyId/hr-report", getHRDayEnd);

// ── Audit trail  (IT / Manager / CEO) ────────────────────────────────────────
// GET /api/day-end/:companyId/audit-trail?date=YYYY-MM-DD&staff_id=
dayEndRouter.get("/:companyId/audit-trail", getDayEndAuditTrail);

// ── Close the day  (Manager / Accountant — write action) ─────────────────────
// POST /api/day-end/:companyId/close
// Body: { closed_by, closed_by_name, date? }
dayEndRouter.post("/:companyId/close", closeDay);

dayEndRouter.get("/:companyId", getDayEndLogs);
dayEndRouter.get("/:companyId/:date", getSingleDayEnd);

export default dayEndRouter;
