import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import allRoutes from './routes/allRoutes.mjs';
import './jobs/inactivity.jon.mjs'

dotenv.config();

const PORT = process.env.PORT || 5050;
const app = express();

app.use(cors());

app.get('/test', (req, res) => {
  res.json({ message: 'working' });
});

app.use(express.json());

app.use(allRoutes);

app.listen(5000, "0.0.0.0", () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
