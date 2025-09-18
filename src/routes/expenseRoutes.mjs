import { Router } from "express";
import { addBudget, getCompanyFinancials, recordEntry } from "../controllers/expenseController.mjs";

export const financeRoutes = Router();

financeRoutes.post("/entry", recordEntry);
financeRoutes.get("/get-financials/:companyId", getCompanyFinancials);
financeRoutes.post('/budget', addBudget);