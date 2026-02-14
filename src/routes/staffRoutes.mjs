import { Router } from "express";
import { createStaff, getAllStaffByCompany, getStaffByRole, getStaffDashboardByCompany, signInStaff } from "../controllers/staffController.mjs";
import { adminResetStaffPassword, changeStaffPassword, forceResetPassword } from "../controllers/auth/staffAuthController.mjs";

export const staffRoutes = Router();

staffRoutes.post('/create-agent', createStaff);
staffRoutes.post('/sign-in', signInStaff);
staffRoutes.get('/', getAllStaffByCompany);
staffRoutes.get('/role', getStaffByRole);
staffRoutes.get('/dashboard', getStaffDashboardByCompany)
staffRoutes.put('/change-password', changeStaffPassword)
staffRoutes.put('/:staff_id/reset-password', adminResetStaffPassword)
staffRoutes.put('/:staff_id/force-reset-password', forceResetPassword)