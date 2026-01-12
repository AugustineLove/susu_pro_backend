import { Router } from "express";
import { approveLoan, getAllLoans } from "../controllers/loanController.mjs";


export const loanRoutes = Router();

loanRoutes.get('/all/:companyId', getAllLoans);
loanRoutes.patch('/approve', approveLoan);