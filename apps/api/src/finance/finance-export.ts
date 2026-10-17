interface FinanceExportSummary {
  trip: { reference: string };
  currencies: Array<{
    currencyCode: string;
    currencyMinorUnit: number;
    ticketRevenueMinor: string;
    additionalRevenueMinor: string;
    grossRevenueMinor: string;
    refundMinor: string;
    netRevenueMinor: string;
    expenseMinor: string;
    contributionMinor: string;
    payoutMinor: string;
    outstandingExpenseMinor: string;
  }>;
  payments: Array<{
    reference: string;
    amountMinor: string;
    currencyCode: string;
    currencyMinorUnit: number;
    booking: { reference: string };
    refunds: Array<{
      reference: string;
      amountMinor: string;
      reason: string;
      recordedAt: Date | string;
      creditNote: { reference: string; issuedAt: Date | string } | null;
    }>;
  }>;
  revenues: Array<{
    reference: string;
    type: string;
    status: string;
    amountMinor: string;
    currencyCode: string;
    currencyMinorUnit: number;
    description: string;
    occurredAt: Date | string;
  }>;
  expenses: Array<{
    reference: string;
    type: string;
    status: string;
    amountMinor: string;
    currencyCode: string;
    currencyMinorUnit: number;
    description: string;
    occurredAt: Date | string;
    payouts: Array<{
      reference: string;
      amountMinor: string;
      paidAt: Date | string;
    }>;
  }>;
}

function at(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rows(summary: FinanceExportSummary): string[][] {
  const result: string[][] = [
    [
      'section',
      'reference',
      'category',
      'status',
      'amount_minor',
      'currency_code',
      'currency_minor_unit',
      'occurred_at',
      'description',
      'related_reference',
    ],
  ];

  for (const currency of summary.currencies) {
    result.push([
      'SUMMARY',
      summary.trip.reference,
      'CONTRIBUTION',
      'CURRENT',
      currency.contributionMinor,
      currency.currencyCode,
      String(currency.currencyMinorUnit),
      '',
      'Net revenue minus active expenses; no FX conversion',
      '',
    ]);
  }
  for (const payment of summary.payments) {
    result.push([
      'TICKET_REVENUE',
      payment.reference,
      'TICKET',
      'SUCCEEDED',
      payment.amountMinor,
      payment.currencyCode,
      String(payment.currencyMinorUnit),
      '',
      'Existing succeeded payment',
      payment.booking.reference,
    ]);
    for (const refund of payment.refunds) {
      result.push([
        'REFUND',
        refund.reference,
        'REFUND',
        'RECORDED',
        refund.amountMinor,
        payment.currencyCode,
        String(payment.currencyMinorUnit),
        at(refund.recordedAt),
        refund.reason,
        refund.creditNote?.reference ?? payment.reference,
      ]);
    }
  }
  for (const revenue of summary.revenues) {
    result.push([
      'ADDITIONAL_REVENUE',
      revenue.reference,
      revenue.type,
      revenue.status,
      revenue.amountMinor,
      revenue.currencyCode,
      String(revenue.currencyMinorUnit),
      at(revenue.occurredAt),
      revenue.description,
      '',
    ]);
  }
  for (const expense of summary.expenses) {
    result.push([
      'EXPENSE',
      expense.reference,
      expense.type,
      expense.status,
      expense.amountMinor,
      expense.currencyCode,
      String(expense.currencyMinorUnit),
      at(expense.occurredAt),
      expense.description,
      '',
    ]);
    for (const payout of expense.payouts) {
      result.push([
        'PAYOUT',
        payout.reference,
        'PAYOUT',
        'RECORDED',
        payout.amountMinor,
        expense.currencyCode,
        String(expense.currencyMinorUnit),
        at(payout.paidAt),
        'Expense settlement; not an additional expense',
        expense.reference,
      ]);
    }
  }
  return result;
}

function csvCell(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

export function financeCsv(summary: FinanceExportSummary): Buffer {
  const newline = String.fromCharCode(13, 10);
  const body = rows(summary)
    .map((row) => row.map(csvCell).join(','))
    .join(newline);
  return Buffer.from(String.fromCharCode(0xfeff) + body + newline, 'utf8');
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function columnName(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: Array<{ name: string; body: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const checksum = crc32(file.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.body.length, 18);
    local.writeUInt32LE(file.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.body.length, 20);
    central.writeUInt32LE(file.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.body.length;
  }

  const centralBody = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBody, end]);
}

export function financeXlsx(summary: FinanceExportSummary): Buffer {
  const sheetRows = rows(summary)
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, columnIndex) =>
            '<c r="' +
            columnName(columnIndex) +
            String(rowIndex + 1) +
            '" t="inlineStr"><is><t>' +
            xml(value) +
            '</t></is></c>',
        )
        .join('');
      return '<row r="' + String(rowIndex + 1) + '">' + cells + '</row>';
    })
    .join('');

  const files = [
    {
      name: '[Content_Types].xml',
      body: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      body: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
        'utf8',
      ),
    },
    {
      name: 'xl/workbook.xml',
      body: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Finance" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'utf8',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      body: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
        'utf8',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      body: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<sheetData>' +
          sheetRows +
          '</sheetData></worksheet>',
        'utf8',
      ),
    },
  ];
  return zipStore(files);
}
