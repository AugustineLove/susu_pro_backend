import express from "express";
import {
  getSystemTotal,
  recordVariance,
  getVariances,
  getVarianceSummary,
  getVarianceById,
  resolveVariance,
} from "../controllers/cashVarianceController.mjs";

const cashVarianceRouter = express.Router({ mergeParams: true });
// Mount at: /api/variance/:companyId/...

// ── Lookup: what did a staff member collect today? ────────────
cashVarianceRouter.get("/system-total",          getSystemTotal);      // ?staff_id=&date=

// ── Record a new variance ─────────────────────────────────────
cashVarianceRouter.post("/",                     recordVariance);

// ── List & filter ────────────────────────────────────────────
cashVarianceRouter.get("/",                      getVariances);        // ?staff_id=&type=&status=&startDate=&endDate=
cashVarianceRouter.get("/summary",               getVarianceSummary);  // per-staff breakdown
cashVarianceRouter.get("/:varianceId",           getVarianceById);

// ── Resolve ───────────────────────────────────────────────────
cashVarianceRouter.patch("/:varianceId/resolve", resolveVariance);

export default cashVarianceRouter;

// In your main app.mjs:
// import varianceRouter from "./routes/cashVarianceRoutes.mjs";
// app.use("/api/variance/:companyId", varianceRouter);
