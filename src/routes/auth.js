import { Router } from 'express';
import { body } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { signToken } from '../middleware/auth.js';

const prisma = new PrismaClient();
const router = Router();

router.post(
  '/login',
  body('username').isString(),
  body('password').isString().isLength({ min: 6 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { username, password } = req.body;
      const user = await prisma.user.findUnique({ where: { username } });
      if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
      const token = signToken({ sub: user.id, username: user.username, role: user.role });
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (e) {
      next(e);
    }
  }
);

export default router;

