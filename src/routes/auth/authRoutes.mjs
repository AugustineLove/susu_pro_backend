import Router from 'express';
import { loginUser } from '../../controllers/auth/loginController.mjs';
const authRouter = Router();

authRouter.post('/login-company', loginUser);

export default authRouter;