import express from "express";
import {
  // Staff payroll setup
  getAllStaffWithPayrollInfo,
  getSalaryProfile,
  upsertSalaryProfile,
  previewStaffPayroll,
  getStaffPayslips,
  // Allowances
  getStaffAllowances,
  addStaffAllowance,
  removeStaffAllowance,
  // Deductions
  getStaffDeductions,
  addStaffDeduction,
  removeStaffDeduction,
  // Types & grades
  getPayrollTypes,
  // Payroll periods
  getPayrollPeriods,
  createPayrollPeriod,
  // Payroll run
  runPayroll,
  approvePayroll,
  markPayrollPaid,
  // Entries & payslips
  getPayrollEntries,
  adjustPayrollEntry,
  getPayslip,
  // Stats
  getPayrollStats,
} from "../controllers/payrollController.mjs";

const payRollRouter = express.Router({ mergeParams: true });

// ── Dashboard ─────────────────────────────────────────────────
payRollRouter.get("/stats",                         getPayrollStats);

// ── Staff payroll info ────────────────────────────────────────
payRollRouter.get("/staff",                         getAllStaffWithPayrollInfo);
payRollRouter.get("/staff/:staffId/profile",        getSalaryProfile);
payRollRouter.post("/staff/:staffId/profile",       upsertSalaryProfile);
payRollRouter.get("/staff/:staffId/preview",        previewStaffPayroll);
payRollRouter.get("/staff/:staffId/payslips",       getStaffPayslips);

// ── Allowances ────────────────────────────────────────────────
payRollRouter.get("/staff/:staffId/allowances",     getStaffAllowances);
payRollRouter.post("/staff/:staffId/allowances",    addStaffAllowance);
payRollRouter.delete("/allowances/:allowanceId",    removeStaffAllowance);

// ── Deductions ────────────────────────────────────────────────
payRollRouter.get("/staff/:staffId/deductions",     getStaffDeductions);
payRollRouter.post("/staff/:staffId/deductions",    addStaffDeduction);
payRollRouter.delete("/deductions/:deductionId",    removeStaffDeduction);

// ── Types & grades ────────────────────────────────────────────
payRollRouter.get("/types",                         getPayrollTypes);

// ── Payroll periods ───────────────────────────────────────────
payRollRouter.get("/periods",                       getPayrollPeriods);
payRollRouter.post("/periods",                      createPayrollPeriod);

// ── Payroll run workflow ──────────────────────────────────────
payRollRouter.post("/periods/:periodId/run",        runPayroll);
payRollRouter.post("/periods/:periodId/approve",    approvePayroll);
payRollRouter.post("/periods/:periodId/mark-paid",  markPayrollPaid);

// ── Payroll entries ───────────────────────────────────────────
payRollRouter.get("/periods/:periodId/entries",     getPayrollEntries);
payRollRouter.patch("/entries/:entryId/adjust",     adjustPayrollEntry);

// ── Payslips ──────────────────────────────────────────────────
payRollRouter.get("/payslips/:payslipId",           getPayslip);

export default payRollRouter;

// In your main app.mjs:
// import payrollRouter from "./routes/payrollRoutes.mjs";
// app.use("/api/payroll/:companyId", payrollRouter);
