import { Router } from "express";
import { createAccount, getAccountsByCustomer } from "../controllers/accountController.mjs";


export const accountRouter = Router();

accountRouter.post('/create', createAccount);
accountRouter.get('/customer/:customerId', getAccountsByCustomer);