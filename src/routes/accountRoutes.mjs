import { Router } from "express";
import { createAccount, getAccountsByCustomer, getLastAccountNumber, getLastAccountNumbersByStaff, getLastCustomerAccountNumber, toggleAccountStatus } from "../controllers/accountController.mjs";


export const accountRouter = Router();

accountRouter.post('/create', createAccount);
accountRouter.get('/customer/:customerId', getAccountsByCustomer);
accountRouter.get('/last-account-number/:staffId', getLastAccountNumber);
accountRouter.get(
  '/last-account-numbers',
  getLastAccountNumbersByStaff
);
accountRouter.get('/last-customer-account-number/:staffId', getLastCustomerAccountNumber);
accountRouter.patch('/:accountId/toggle-status', toggleAccountStatus);