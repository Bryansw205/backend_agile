import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { PrismaClient } from '@prisma/client';
import { getPersonByDni } from '../services/dniService.js';

const prisma = new PrismaClient();
const router = Router();

// Buscar/filtrar clientes
router.get(
  '/',
  requireAuth,
  query('q').optional().isString(),
  query('dni').optional().isString(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { q, dni } = req.query;
      const where = {};
      // If DNI provided, allow prefix matching (e.g., first 3 digits)
      if (dni) where.dni = { startsWith: String(dni) };
      if (q) {
        where.OR = [
          { firstName: { contains: String(q), mode: 'insensitive' } },
          { lastName: { contains: String(q), mode: 'insensitive' } },
          { dni: { contains: String(q) } }
        ];
      }
      const clients = await prisma.client.findMany({
        where,
        include: { loans: true },
        orderBy: { id: 'desc' }
      });
      res.json(clients);
    } catch (e) { next(e); }
  }
);

// Obtener datos por DNI desde API y/o crear/actualizar cliente localmente
router.post(
  '/lookup',
  requireAuth,
  body('dni').isString().matches(/^[0-9]{8}$/),
  handleValidation,
  async (req, res, next) => {
    try {
      const { dni } = req.body;
      const person = await getPersonByDni(dni);
      let client = await prisma.client.findUnique({ where: { dni } });
      if (!client) {
        client = await prisma.client.create({ data: { dni, firstName: person.firstName, lastName: person.lastName } });
      } else {
        // actualizar nombres si cambiaron
        if (client.firstName !== person.firstName || client.lastName !== person.lastName) {
          client = await prisma.client.update({ where: { id: client.id }, data: { firstName: person.firstName, lastName: person.lastName } });
        }
      }
      res.json(client);
    } catch (e) { next(e); }
  }
);

// Detalle de cliente
router.get(
  '/:id',
  requireAuth,
  param('id').isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const client = await prisma.client.findUnique({ where: { id }, include: { loans: { orderBy: { id: 'desc' }, include: { schedules: true, createdBy: true } } } });
      if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

      // Enriquecer cada préstamo con montos calculados
      const loans = (client.loans || []).map((l) => {
        const schedules = l.schedules || [];
        const sum = (arr, sel) => arr.reduce((a, x) => a + Number(x[sel] || 0), 0);
        const totalInstallments = sum(schedules, 'installmentAmount');
        const totalInterest = sum(schedules, 'interestAmount');
        const paidInstallments = schedules.filter(s => s.status === 'PAGADO');
        const remainingInstallments = schedules.filter(s => s.status !== 'PAGADO');
        const paidAmount = sum(paidInstallments, 'installmentAmount');
        const gained = sum(paidInstallments, 'interestAmount');
        const debt = totalInstallments - paidAmount;
        const remainingCount = remainingInstallments.length;

        return {
          ...l,
          paidAmount,
          gained, // ganancia realizada por cuotas pagadas
          expectedInterest: totalInterest, // opcional: interés total esperado
          debt,
          remainingCount,
        };
      });

      res.json({ ...client, loans });
    } catch (e) { next(e); }
  }
);

export default router;
