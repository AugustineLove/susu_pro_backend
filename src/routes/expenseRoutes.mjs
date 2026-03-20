import { Router } from "express";
import { addBudget, recordEntry } from "../controllers/expenseController.mjs";
import { getCompanyFinancials } from "../controllers/financeController.mjs";

export const financeRoutes = Router();

financeRoutes.post("/entry", recordEntry);
financeRoutes.get("/get-financials/:companyId", getCompanyFinancials);
financeRoutes.post('/budget', addBudget);