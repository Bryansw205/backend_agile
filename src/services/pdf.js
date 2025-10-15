import PDFDocument from 'pdfkit';

// Escribe el contenido del PDF en un documento existente (no hace pipe ni end)
export function buildSchedulePdf(doc, { client, loan, schedule }) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right; // ~515 para A4 con margen 40

  doc.fontSize(16).text('Cronograma de Pagos', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10);
  doc.text(`Cliente: ${client.firstName} ${client.lastName} (DNI: ${client.dni})`, { width: contentWidth });
  doc.text(`Préstamo: Monto ${formatCurrency(loan.principal)} | Tasa anual ${(Number(loan.interestRate) * 100).toFixed(2)}% | Plazo ${loan.termCount} meses`, { width: contentWidth });
  const totalToPay = schedule.reduce((a, r) => a + Number(r.installmentAmount || 0), 0);
  doc.text(`Total a pagar: ${formatCurrency(totalToPay)}`, { width: contentWidth });
  doc.text(`Fecha de inicio: ${formatDate(loan.startDate)}`, { width: contentWidth });
  doc.moveDown(0.5);

  // Definir columnas con anchos que sumen contentWidth
  const columns = [
    { key: 'n', title: 'Cuota', width: 50, align: 'left' },
    { key: 'fecha', title: 'Fecha', width: 90, align: 'left' },
    { key: 'cuota', title: 'Cuota (S/)', width: 95, align: 'right' },
    { key: 'interes', title: 'Interés', width: 90, align: 'right' },
    { key: 'capital', title: 'Capital', width: 90, align: 'right' },
    { key: 'saldo', title: 'Saldo', width: contentWidth - (50 + 90 + 95 + 90 + 90), align: 'right' },
  ];

  const rowHeight = 18;
  const startX = doc.page.margins.left;
  let y = doc.y + 6;

  const drawHeader = () => {
    doc.font('Helvetica-Bold');
    let x = startX;
    columns.forEach(col => {
      doc.text(col.title, x, y, { width: col.width, align: col.align });
      x += col.width;
    });
    y += rowHeight - 6;
    doc.moveTo(startX, y).lineTo(startX + contentWidth, y).stroke();
    y += 6;
    doc.font('Helvetica');
  };

  const drawRow = (r) => {
    let x = startX;
    const cells = [
      { key: 'n', value: String(r.installmentNumber) },
      { key: 'fecha', value: formatDate(r.dueDate) },
      { key: 'cuota', value: formatCurrency(r.installmentAmount) },
      { key: 'interes', value: formatCurrency(r.interestAmount) },
      { key: 'capital', value: formatCurrency(r.principalAmount) },
      { key: 'saldo', value: formatCurrency(r.remainingBalance) },
    ];
    cells.forEach((cell, idx) => {
      const col = columns[idx];
      doc.text(cell.value, x, y, { width: col.width, align: col.align });
      x += col.width;
    });
    y += rowHeight;
  };

  const bottomY = doc.page.height - doc.page.margins.bottom;
  drawHeader();
  for (const row of schedule) {
    if (y + rowHeight > bottomY) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    drawRow(row);
  }
}

export function createPdfDocument() {
  return new PDFDocument({ size: 'A4', margin: 40 });
}

function formatCurrency(n) {
  const num = typeof n === 'number' ? n : Number(n);
  return `S/ ${num.toFixed(2)}`;
}

function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}
