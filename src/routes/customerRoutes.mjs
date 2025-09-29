import { Router } from "express";
import { createCustomer, deleteCustomer, getCustomerById, getCustomersByCompany, getCustomersByStaff, udpateCustomerInfoMobile, updateCustomer } from "../controllers/customerController.mjs";
import { requirePermission } from "../middlewares/staffPermissions.mjs";
import { verifyCompanyToken } from "../middlewares/verifyCompany.mjs";


export const customerRouter = Router();

customerRouter.post('/create',verifyCompanyToken, requirePermission('CUSTOMER_CREATE'), createCustomer);
customerRouter.get('/staff/:staffId', getCustomersByStaff);
customerRouter.get('/company/:companyId', getCustomersByCompany);
customerRouter.delete('/delete', deleteCustomer);
customerRouter.put('/update-mobile', udpateCustomerInfoMobile); 
customerRouter.get('/:customerId', getCustomerById);
customerRouter.put('/customer', updateCustomer);


