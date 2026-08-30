import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import allRoutes from './routes/allRoutes.mjs';
import './jobs/inactivity.jon.mjs';

dotenv.config();

const PORT = Number(process.env.PORT) || 5001;

const app = express();

app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json());

app.get('/test', (req, res) => {
  res.json({ message: 'working' });
});

app.use(allRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});