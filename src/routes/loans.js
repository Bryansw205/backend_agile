import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Lima';
import { generateSchedule } from '../services/schedule.js';
import { buildSchedulePdf, createPdfDocument } from '../services/pdf.js';
import PDFDocument from 'pdfkit';

const prisma = new PrismaClient();
const router = Router();

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Vista previa de préstamo (no persiste)
router.post(
  '/preview',
  requireAuth,
  body('principal').isFloat({ gt: 0 }),
  body('interestRate').isFloat({ min: 0 }),
  body('termCount').isInt({ min: 6, max: 60 }),
  body('startDate').isISO8601(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { principal, interestRate, termCount, startDate } = req.body;
      if (Number(principal) < 300) return res.status(400).json({ error: 'El monto mínimo es S/ 300.' });
      if (Number(principal) > 200000) return res.status(400).json({ error: 'El monto máximo es S/ 200,000.' });
      if (Number(interestRate) < 0.10) return res.status(400).json({ error: 'La tasa mínima es 10% (0.10).' });
      const start = dayjs.tz(startDate, TZ).startOf('day');
      const today = dayjs.tz(new Date(), TZ).startOf('day');
      if (start.isBefore(today)) return res.status(400).json({ error: 'La fecha del préstamo no puede ser pasada' });

      const schedule = generateSchedule({ principal: Number(principal), interestRate: Number(interestRate), termCount: Number(termCount), startDate });
      const totalInterest = round2(schedule.reduce((a, r) => a + Number(r.interestAmount), 0));
      const totalAmount = round2(schedule.reduce((a, r) => a + Number(r.installmentAmount), 0));
      const installmentAmount = schedule.length ? Number(schedule[0].installmentAmount) : 0;
      const lastDueDate = schedule.length ? schedule[schedule.length - 1].dueDate : null;
      res.json({
        summary: {
          principal: Number(principal),
          interestRate: Number(interestRate),
          termCount: Number(termCount),
          startDate,
          installmentAmount: round2(installmentAmount),
          totalInterest,
          totalAmount,
          lastDueDate
        },
        schedule
      });
    } catch (e) { next(e); }
  }
);

// Listar préstamos con filtros básicos
router.get(
  '/',
  requireAuth,
  query('status').optional().isString(),
  query('clientId').optional().isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const where = {};
      if (req.query.status) where.status = req.query.status;
      if (req.query.clientId) where.clientId = Number(req.query.clientId);
      const loans = await prisma.loan.findMany({ where, include: { client: true, createdBy: true }, orderBy: { id: 'desc' } });
      res.json(loans);
    } catch (e) { next(e); }
  }
);

// Crear un préstamo y su cronograma
router.post(
  '/',
  requireAuth,
  body('clientId').isInt(),
  body('principal').isFloat({ gt: 0 }),
  body('interestRate').isFloat({ min: 0 }),
  body('termCount').isInt({ min: 6, max: 60 }),
  body('startDate').isISO8601(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { clientId, principal, interestRate, termCount, startDate } = req.body;
      const userId = Number(req.user?.sub || req.user?.id);
      if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
      // Validación de fecha: no en pasado (solo fecha, no hora)
      const start = dayjs.tz(startDate, TZ).startOf('day');
      const today = dayjs.tz(new Date(), TZ).startOf('day');
      if (start.isBefore(today)) return res.status(400).json({ error: 'La fecha del préstamo no puede ser pasada' });

      if (Number(principal) < 300) return res.status(400).json({ error: 'El monto mínimo es S/ 300.' });
      if (Number(principal) > 200000) return res.status(400).json({ error: 'El monto máximo es S/ 200,000.' });
      if (Number(interestRate) < 0.10) return res.status(400).json({ error: 'La tasa mínima es 10% (0.10).' });
      if (Number(principal) >= 5350 && req.body.declarationAccepted !== true) {
        return res.status(400).json({ error: 'Para montos desde S/ 5,350 debe descargar y aceptar la Declaración Jurada.' });
      }

      const client = await prisma.client.findUnique({ where: { id: Number(clientId) } });
      if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

      // Regla: un solo préstamo no pagado por cliente a la vez
      const existing = await prisma.loan.findFirst({
        where: { clientId: client.id, status: { not: 'PAGADO' } }
      });
      if (existing) {
        return res.status(400).json({ error: 'El cliente ya tiene un préstamo activo.' });
      }

      const createdLoan = await prisma.$transaction(async (tx) => {
        const loan = await tx.loan.create({
          data: {
            clientId: client.id,
            createdByUserId: userId,
            principal: String(principal),
            interestRate: String(interestRate),
            termCount,
            // Guardar la fecha de inicio a mediodía en Lima para evitar desfase (-05:00)
            startDate: dayjs.tz(startDate, TZ).hour(12).minute(0).second(0).millisecond(0).toDate(),
            status: 'ACTIVO'
          }
        });

        const schedule = generateSchedule({ principal: Number(principal), interestRate: Number(interestRate), termCount, startDate });
        await Promise.all(schedule.map((row) => tx.paymentSchedule.create({
          data: {
            loanId: loan.id,
            installmentNumber: row.installmentNumber,
            dueDate: row.dueDate,
            installmentAmount: String(row.installmentAmount),
            principalAmount: String(row.principalAmount),
            interestAmount: String(row.interestAmount),
            remainingBalance: String(row.remainingBalance)
          }
        })));

        return loan;
      });

      const full = await prisma.loan.findUnique({ where: { id: createdLoan.id }, include: { client: true, schedules: true } });
      res.status(201).json(full);
    } catch (e) { next(e); }
  }
);

// Detalle de préstamo con cronograma
router.get(
  '/:id',
  requireAuth,
  param('id').isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const loan = await prisma.loan.findUnique({ where: { id }, include: { client: true, createdBy: true, schedules: { orderBy: { installmentNumber: 'asc' } } } });
      if (!loan) return res.status(404).json({ error: 'Préstamo no encontrado' });
      const now = dayjs.tz(new Date(), TZ).startOf('day');
      const schedules = loan.schedules.map((s) => {
        const due = dayjs.tz(s.dueDate, TZ).startOf('day');
        const paidAt = s.paidAt ? dayjs.tz(s.paidAt, TZ).startOf('day') : null;
        let daysOverdue = 0;
        if (paidAt) {
          if (paidAt.isAfter(due)) daysOverdue = paidAt.diff(due, 'day');
        } else if (now.isAfter(due)) {
          daysOverdue = now.diff(due, 'day');
        }
        let computedStatus = s.status;
        if (!paidAt && now.isAfter(due) && s.status !== 'PAGADO') computedStatus = 'ATRASADO';
        if (paidAt) computedStatus = 'PAGADO';
        return { ...s, computedStatus, daysOverdue };
      });
      res.json({ ...loan, schedules });
    } catch (e) { next(e); }
  }
);

// Actualizar estado de pago de una cuota (pagar/desmarcar)
router.patch(
  '/:loanId/schedules/:scheduleId',
  requireAuth,
  param('loanId').isInt(),
  param('scheduleId').isInt(),
  body('paid').isBoolean(),
  body('paidAt').optional().isISO8601(),
  handleValidation,
  async (req, res, next) => {
    try {
      const loanId = Number(req.params.loanId);
      const scheduleId = Number(req.params.scheduleId);
      const schedule = await prisma.paymentSchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule || schedule.loanId !== loanId) return res.status(404).json({ error: 'Cuota no encontrada' });

      const { paid, paidAt } = req.body;
      const data = paid
        ? { status: 'PAGADO', paidAt: paidAt ? new Date(paidAt) : new Date() }
        : { status: 'PENDIENTE', paidAt: null };

      const updated = await prisma.$transaction(async (tx) => {
        const up = await tx.paymentSchedule.update({ where: { id: scheduleId }, data });
        // Recalcular estado del préstamo
        const counts = await tx.paymentSchedule.groupBy({
          by: ['status'],
          where: { loanId },
          _count: { _all: true }
        });
        const total = counts.reduce((a, c) => a + c._count._all, 0);
        const paidCount = counts.find(c => c.status === 'PAGADO')?._count._all || 0;
        const overdueCount = counts.find(c => c.status === 'ATRASADO')?._count._all || 0;
        let newStatus = 'ACTIVO';
        if (paidCount === total) newStatus = 'PAGADO';
        else if (overdueCount > 0) newStatus = 'ATRASADO';
        else newStatus = 'ACTIVO';
        await tx.loan.update({ where: { id: loanId }, data: { status: newStatus } });
        return up;
      });
      res.json(updated);
    } catch (e) { next(e); }
  }
);

// Exportar cronograma a PDF
router.get(
  '/:id/schedule.pdf',
  requireAuth,
  param('id').isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const loan = await prisma.loan.findUnique({ where: { id }, include: { client: true, schedules: { orderBy: { installmentNumber: 'asc' } } } });
      if (!loan) return res.status(404).json({ error: 'Préstamo no encontrado' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="cronograma_loan_${loan.id}.pdf"`);
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      doc.pipe(res);
      buildSchedulePdf(doc, { client: loan.client, loan, schedule: loan.schedules });
      doc.end();
    } catch (e) { next(e); }
  }
);

export default router;
