import { Router } from "express";
import { createCustomer, deleteCustomer, getCustomerByAccountNumber, getCustomerById, getCustomersByCompany, getCustomersByStaff, loginCustomer, searchCustomers, udpateCustomerInfoMobile, updateCustomer } from "../controllers/customerController.mjs";
import { requirePermission } from "../middlewares/staffPermissions.mjs";
import { verifyCompanyToken } from "../middlewares/verifyCompany.mjs";


export const customerRouter = Router();

customerRouter.post('/create',createCustomer);
customerRouter.get('/staff/:staffId', getCustomersByStaff);
customerRouter.get('/company/:companyId', getCustomersByCompany);
customerRouter.delete('/delete', deleteCustomer);
customerRouter.put('/update-mobile', udpateCustomerInfoMobile); 
customerRouter.get('/:customerId', getCustomerById);
customerRouter.put('/customer', updateCustomer);
customerRouter.get("/account/:accountNumber", getCustomerByAccountNumber);
customerRouter.post("/login", loginCustomer);
customerRouter.get("/:companyId/search", searchCustomers)