import Router from 'express';
import { loginCompany } from '../../controllers/auth/loginController.mjs';
const authRouter = Router();

authRouter.post('/login-company', loginCompany);

export default authRouter;