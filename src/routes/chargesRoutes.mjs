// routes/chargesRoutes.mjs
// ─── Account Charges Routes ───────────────────────────────────────────────────

import express from "express";
import {
  applyCharge,
  reverseCharge,
  getChargesByAccount,
  getChargesByCustomer,
  getChargeTypes,
  runChargesMigration,
} from "../controllers/chargesController.mjs";

const chargesRouter = express.Router();

// Metadata
chargesRouter.get("/types",              getChargeTypes);
chargesRouter.get("/migrate",            runChargesMigration);

// Queries
chargesRouter.get("/account/:accountId", getChargesByAccount);
chargesRouter.get("/customer/:customerId", getChargesByCustomer);

// Actions
chargesRouter.post("/:accountId",        applyCharge);
chargesRouter.post("/:chargeId/reverse", reverseCharge);

export default chargesRouter;

/*
── Mount in app.mjs ────────────────────────────────────────────────────────────

import chargesRouter from "./routes/chargesRoutes.mjs";
app.use("/api/charges", chargesRouter);

── Also add to transactionRouter for inline access ───────────────────────────

import { applyCharge } from "../controllers/chargesController.mjs";
transactionRouter.post('/charge/:accountId', applyCharge);

────────────────────────────────────────────────────────────────────────────────
*/
