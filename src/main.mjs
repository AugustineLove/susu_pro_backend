import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import allRoutes from './routes/allRoutes.mjs';

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

app.use(allRoutes);

app.listen(5000, "0.0.0.0", () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
