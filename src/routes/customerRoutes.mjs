import { Router } from "express";
import { createCustomer, deleteCustomer, getCustomersByCompany, getCustomersByStaff, udpateCustomerInfoMobile } from "../controllers/customerController.mjs";


export const customerRouter = Router();

customerRouter.post('/create', createCustomer);
customerRouter.get('/staff/:staffId', getCustomersByStaff);
customerRouter.get('/company/:companyId', getCustomersByCompany);
customerRouter.delete('/delete', deleteCustomer);
customerRouter.put('/update-mobile/:customerId', udpateCustomerInfoMobile); 
