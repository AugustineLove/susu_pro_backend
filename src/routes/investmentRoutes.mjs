
import { Router } from "express";

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

import {
  reverseInvestmentCreation,
  lookupInvestmentForReversal,
} from "../controllers/investmentReversalController.mjs";

import {
  getAllInvestments,
  getInvestmentStats,
  getMaturingInvestments,
} from "../controllers/investmentQueryController.mjs";

const investmentRouter = Router();

// ── One-time setup ─────────────────────────────────────────────────────────
investmentRouter.get("/migrate", runMigration);

// ── Dashboard queries (put these BEFORE the /:id route so "all"/"stats"/
//    "maturing" aren't swallowed as an :id param) ───────────────────────────
investmentRouter.get("/all/:company_id", getAllInvestments);
investmentRouter.get("/stats/:company_id", getInvestmentStats);
investmentRouter.get("/maturing/:company_id", getMaturingInvestments);
investmentRouter.get("/products", getInvestmentProducts);
investmentRouter.get("/products/:company_id", getInvestmentProducts);

// ── Reversal lookup + action ────────────────────────────────────────────────
investmentRouter.get("/lookup/:reference", lookupInvestmentForReversal);
investmentRouter.post("/reverse", reverseInvestmentCreation);

// ── Core CRUD / lifecycle ───────────────────────────────────────────────────
investmentRouter.post("/create", createInvestment);
investmentRouter.post("/fund", fundInvestment);
investmentRouter.get("/customer/:customerId", getCustomerInvestments);
investmentRouter.post("/:id/mature", matureInvestment);
investmentRouter.post("/:id/rollover", rolloverInvestment);
investmentRouter.get("/:id", getInvestmentById);

export default investmentRouter;
