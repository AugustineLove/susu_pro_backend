import express, { Router } from "express";
import {
  createEntryBatch,
  getPendingBatches,
  getBatchByCode,
  updateEntryBatch,
  voidEntryBatch,
  approveEntryBatch,
  rejectEntryBatch,
} from "../controllers/entryBatchController.mjs";

export const entryBatchRoute = Router();

entryBatchRoute.get("/pending", getPendingBatches);
entryBatchRoute.post("/", createEntryBatch);
entryBatchRoute.get("/:code", getBatchByCode);
entryBatchRoute.patch("/:code", updateEntryBatch);
entryBatchRoute.delete("/:code", voidEntryBatch);
entryBatchRoute.post("/:code/approve", approveEntryBatch);
entryBatchRoute.post("/:code/reject", rejectEntryBatch);
