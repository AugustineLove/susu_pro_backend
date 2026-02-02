import { Router } from "express";
import { getBudgetById, getBudgetsByCompanyId, sellCash, toggleBudgetStatus } from "../controllers/budgetController.mjs";

const budgetRoutes = Router();

budgetRoutes.get('/:id', getBudgetById);
budgetRoutes.post('/sell-cash', sellCash);
budgetRoutes.patch('/:budgetId/toggle-status', toggleBudgetStatus)
budgetRoutes.get("/company/:companyId", getBudgetsByCompanyId)

export default budgetRoutes;