import { Router } from "express";
import { createStaff, getAllStaffByCompany, getStaffByRole, signInStaff } from "../controllers/staffController.mjs";

export const staffRoutes = Router();

staffRoutes.post('/create-agent', createStaff);
staffRoutes.post('/sign-in', signInStaff);
staffRoutes.get('/', getAllStaffByCompany);
staffRoutes.get('/role', getStaffByRole);