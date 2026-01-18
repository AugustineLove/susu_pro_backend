import { Router } from "express";
import { createAccount, getAccountsByCustomer, getLastAccountNumber, getLastAccountNumbersByStaff } from "../controllers/accountController.mjs";


export const accountRouter = Router();

accountRouter.post('/create', createAccount);
accountRouter.get('/customer/:customerId', getAccountsByCustomer);
accountRouter.get('/last-account-number/:staffId', getLastAccountNumber);
accountRouter.get(
  '/last-account-numbers',
  getLastAccountNumbersByStaff
);
