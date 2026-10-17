interface ExportMoney {
  currencyCode: string;
  currencyMinorUnit: number;
  ticketRevenueMinor: string;
  additionalRevenueMinor: string;
  refundMinor: string;
  netRevenueMinor: string;
  expenseMinor: string;
  contributionMinor: string;
  payoutMinor: string;
}

interface ReportingExportOverview {
  period: { from: Date | string; to: Date | string; semantics: string };
  activity: Record<string, number>;
  commercial: Record<string, number | null>;
  finance: { currencies: ExportMoney[]; fxConversionApplied: false };
  operations: Record<string, number | null>;
  incidents: {
    incidentCount: number;
    openIncidentCount: number;
    resolvedIncidentCount: number;
    severity: Record<string, number>;
    averageResolutionMinutes: number | null;
  };
  baggage: Record<string, number | null>;
  fleet: Record<string, number | null>;
  routes: Array<{
    routeCode: string;
    routeName: string;
    routeVersion: number;
    tripCount: number;
    passengerCount: number;
    soldSeatCount: number;
    offeredSeatCapacity: number;
    loadFactor: number | null;
    cancellationCount: number;
    incidentCount: number;
    currencies: ExportMoney[];
  }>;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function rows(overview: ReportingExportOverview): string[][] {
  const result: string[][] = [['section', 'dimension', 'metric', 'value', 'currency', 'minor_unit']];
  result.push(['PERIOD', '', 'from', scalar(overview.period.from), '', '']);
  result.push(['PERIOD', '', 'to', scalar(overview.period.to), '', '']);
  for (const [metric, value] of Object.entries(overview.activity)) {
    result.push(['ACTIVITY', '', metric, scalar(value), '', '']);
  }
  for (const [metric, value] of Object.entries(overview.commercial)) {
    result.push(['COMMERCIAL', '', metric, scalar(value), '', '']);
  }
  for (const currency of overview.finance.currencies) {
    for (const metric of [
      'ticketRevenueMinor',
      'additionalRevenueMinor',
      'refundMinor',
      'netRevenueMinor',
      'expenseMinor',
      'contributionMinor',
      'payoutMinor',
    ] as const) {
      result.push([
        'FINANCE',
        '',
        metric,
        currency[metric],
        currency.currencyCode,
        String(currency.currencyMinorUnit),
      ]);
    }
  }
  for (const [metric, value] of Object.entries(overview.operations)) {
    result.push(['OPERATIONS', '', metric, scalar(value), '', '']);
  }
  result.push(['INCIDENTS', '', 'incidentCount', String(overview.incidents.incidentCount), '', '']);
  result.push([
    'INCIDENTS',
    '',
    'openIncidentCount',
    String(overview.incidents.openIncidentCount),
    '',
    '',
  ]);
  for (const [level, value] of Object.entries(overview.incidents.severity)) {
    result.push(['INCIDENTS', level, 'severityCount', String(value), '', '']);
  }
  for (const [metric, value] of Object.entries(overview.baggage)) {
    result.push(['BAGGAGE', '', metric, scalar(value), '', '']);
  }
  for (const [metric, value] of Object.entries(overview.fleet)) {
    result.push(['FLEET', '', metric, scalar(value), '', '']);
  }
  for (const route of overview.routes) {
    const dimension = `${route.routeCode} v${route.routeVersion}`;
    result.push(['ROUTE', dimension, 'tripCount', String(route.tripCount), '', '']);
    result.push(['ROUTE', dimension, 'passengerCount', String(route.passengerCount), '', '']);
    result.push(['ROUTE', dimension, 'soldSeatCount', String(route.soldSeatCount), '', '']);
    result.push([
      'ROUTE',
      dimension,
      'offeredSeatCapacity',
      String(route.offeredSeatCapacity),
      '',
      '',
    ]);
    result.push(['ROUTE', dimension, 'loadFactor', scalar(route.loadFactor), '', '']);
    result.push(['ROUTE', dimension, 'incidentCount', String(route.incidentCount), '', '']);
    for (const currency of route.currencies) {
      result.push([
        'ROUTE_FINANCE',
        dimension,
        'contributionMinor',
        currency.contributionMinor,
        currency.currencyCode,
        String(currency.currencyMinorUnit),
      ]);
    }
  }
  return result;
}

function csvCell(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

export function reportingCsv(overview: ReportingExportOverview): Buffer {
  const newline = String.fromCharCode(13, 10);
  const body = rows(overview)
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
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.body.length, 18);
    local.writeUInt32LE(file.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.body.length, 20);
    central.writeUInt32LE(file.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.body.length;
  }
  const centralBody = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBody, end]);
}

export function reportingXlsx(overview: ReportingExportOverview): Buffer {
  const sheetRows = rows(overview)
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
  return zipStore([
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
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Reporting" sheetId="1" r:id="rId1"/></sheets></workbook>',
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
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          sheetRows +
          '</sheetData></worksheet>',
        'utf8',
      ),
    },
  ]);
}
