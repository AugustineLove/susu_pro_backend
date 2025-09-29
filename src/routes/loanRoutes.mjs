import { Router } from "express";
import { createLoan } from "../controllers/loanController.mjs";


export const loanRoutes = Router();

loanRoutes.post('/create', createLoan);