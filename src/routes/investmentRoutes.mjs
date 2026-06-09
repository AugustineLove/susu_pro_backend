// routes/investmentRoutes.mjs
// ─── Investment Account Routes ────────────────────────────────────────────────

import express from "express";
import {
  createInvestment,
  fundInvestment,
  getInvestmentProducts,
  getCustomerInvestments,
  getInvestmentById,
  matureInvestment,
  rolloverInvestment,
  runMigration,
} from "../controllers/investmentController.mjs";

const investmentRouter = express.Router();

// ── Products catalogue ────────────────────────────────────────────────────────
investmentRouter.get("/products/:company_id", getInvestmentProducts);

// ── CRUD ──────────────────────────────────────────────────────────────────────
investmentRouter.post("/create",      createInvestment);
investmentRouter.post("/fund",        fundInvestment);
investmentRouter.get("/customer/:customerId", getCustomerInvestments);
investmentRouter.get("/:id",          getInvestmentById);

// ── Lifecycle ─────────────────────────────────────────────────────────────────
investmentRouter.post("/:id/mature",   matureInvestment);
investmentRouter.post("/:id/rollover", rolloverInvestment);

// ── One-time migration ────────────────────────────────────────────────────────
investmentRouter.get("/migrate", runMigration);

export default investmentRouter;

/*
── Mount in your main app.mjs / server.mjs ───────────────────────────────────

import investmentRoutes from "./routes/investmentRoutes.mjs";
app.use("/api/investments", investmentRoutes);

─────────────────────────────────────────────────────────────────────────────*/
