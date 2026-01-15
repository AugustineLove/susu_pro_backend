import { Router } from "express";
import { getFloatActivity } from "../controllers/budgetController.mjs";

export const floatRoutes = Router();

floatRoutes.get("/:id/activity", getFloatActivity);