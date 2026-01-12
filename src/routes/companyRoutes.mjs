import express from 'express';
import { createCompany, getAllCompanies, getCompanyStats, loginNotification, smsOrEmailNotifications, updateProfile } from '../controllers/companyController.mjs';
import { verifyCompanyToken } from '../middlewares/verifyCompany.mjs';
import { setTwoStepVerification, verifyTwoFactor } from '../controllers/securityController.mjs';
import { changeUserPassword } from '../controllers/userController.mjs';

const companyRoutes = express.Router();

companyRoutes.post('/create', createCompany);
companyRoutes.get('/all', getAllCompanies);
companyRoutes.get('/dashboard/stats', verifyCompanyToken, getCompanyStats);
companyRoutes.post('/update-profile', updateProfile);
companyRoutes.post('/change-password', changeUserPassword);
companyRoutes.post('/toggle-2fa', setTwoStepVerification);
companyRoutes.post('/verify-2fa', verifyTwoFactor)
companyRoutes.post('/login-notifications', loginNotification);
companyRoutes.post('/sms-email-notifications', smsOrEmailNotifications);
export default companyRoutes;
