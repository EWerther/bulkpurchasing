function env(key: string, fallback?: string): string {
  const v = process.env[key]
  if (v !== undefined) return v
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required env var: ${key}`)
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  return v !== undefined ? parseInt(v, 10) : fallback
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined) return fallback
  return v === 'true' || v === '1'
}

// Per-instance credentials — each SQL Server instance has its own login
const ftxCreds  = { user: env('DB_FTX_USER'),  password: env('DB_FTX_PASSWORD') }
const sbylCreds = { user: env('DB_SBYL_USER'), password: env('DB_SBYL_PASSWORD') }
const tfmCreds  = { user: env('DB_TFM_USER'),  password: env('DB_TFM_PASSWORD') }

export const config = {
  db: {
    encrypt: envBool('DB_SQL_ENCRYPT', false),
    trustServerCertificate: envBool('DB_SQL_TRUST_SERVER_CERT', true),
    pools: {
      // FTX instance (20.10.0.104,49750)
      LCDataFTX:         { server: env('DB_LCDATAFTX_SERVER'),         database: env('DB_LCDATAFTX_DATABASE'),         ...ftxCreds },
      CustomDataFTX:     { server: env('DB_CUSTOMDATAFTX_SERVER'),     database: env('DB_CUSTOMDATAFTX_DATABASE'),     ...ftxCreds },
      // SBYL instance (10.60.20.20,1439)
      LCDataSBYL:        { server: env('DB_LCDATASBYL_SERVER'),        database: env('DB_LCDATASBYL_DATABASE'),        ...sbylCreds },
      CustomDataSBYL:    { server: env('DB_CUSTOMDATASBYL_SERVER'),    database: env('DB_CUSTOMDATASBYL_DATABASE'),    ...sbylCreds },
      // TFM instance (10.60.20.20,8080)
      LCDataTFM:         { server: env('DB_LCDATATFM_SERVER'),         database: env('DB_LCDATATFM_DATABASE'),         ...tfmCreds },
      CustomDataTFMProd: { server: env('DB_CUSTOMDATATFMPROD_SERVER'), database: env('DB_CUSTOMDATATFMPROD_DATABASE'), ...tfmCreds },
      CSGWebPortal:      { server: env('DB_CSGWEBPORTAL_SERVER'),      database: env('DB_CSGWEBPORTAL_DATABASE'),      ...tfmCreds },
    },
  },
  poReview: {
    minDOC: envInt('POREVIEW_MIN_DOC', 15),
    maxDOC: envInt('POREVIEW_MAX_DOC', 70),
    defaultMonthsAhead: envInt('POREVIEW_DEFAULT_MONTHS_AHEAD', 4),
  },
  poSchedule: {
    minDOC: envInt('POSCHEDULE_MIN_DOC', 15),
    maxDOC: envInt('POSCHEDULE_MAX_DOC', 70),
    minOrderQty: envInt('POSCHEDULE_MIN_ORDER_QTY', 50),
    maxOrderQty: envInt('POSCHEDULE_MAX_ORDER_QTY', 400),
    etaDiffThresholdDays: envInt('POSCHEDULE_ETA_DIFF_THRESHOLD_DAYS', 2),
    qtyDiffThresholdPct: envInt('POSCHEDULE_QTY_DIFF_THRESHOLD_PCT', 10),
    tfmVendorNameFTX: env('POSCHEDULE_TFM_VENDOR_NAME_FTX', 'TFM USA LLC'),
    tfmVendorIdFTX: envInt('POSCHEDULE_TFM_VENDOR_ID_FTX', 24),
    tfmVendorNameSBYL: env('POSCHEDULE_TFM_VENDOR_NAME_SBYL', 'TFM USA'),
    tfmVendorIdSBYL: envInt('POSCHEDULE_TFM_VENDOR_ID_SBYL', 2),
  },
  production: {
    dailyCapacity: envInt('PRODUCTION_DAILY_CAPACITY', 400),
    feasibilityAllowedCategories: env('PRODUCTION_FEASIBILITY_ALLOWED_CATEGORIES', 'Mattress').split(',').map(s => s.trim()),
    feasibilityIgnoredCategories: env('PRODUCTION_FEASIBILITY_IGNORED_CATEGORIES', 'Packet').split(',').map(s => s.trim()),
    feasibilityIgnoredSKUs: env('PRODUCTION_FEASIBILITY_IGNORED_SKUS', 'FRS-MD').split(',').map(s => s.trim()),
    substitutes: parseSubstitutes(env('PRODUCTION_FEASIBILITY_SUBSTITUTES', '')),
    boardAllowedCategories: env('PRODUCTION_BOARD_ALLOWED_CATEGORIES', 'Mattress').split(',').map(s => s.trim()),
  },
  supplyPurchasing: {
    tfmWarehouseId: envInt('SUPPLY_PURCHASING_TFM_WHSE_ID', 2),
    source: 'claude tfm portal',
  },
  features: {
    enableWriteActions: envBool('ENABLE_WRITE_ACTIONS', false),
    enableFactoryWrites: envBool('ENABLE_FACTORY_WRITES', false),
  },
  factory: {
    lines: envInt('FACTORY_LINES', 2),
    shift1Start: envInt('FACTORY_SHIFT1_START', 6),   // hour in 24h (6 = 6am)
    shift1End:   envInt('FACTORY_SHIFT1_END',   14),  // 2pm
    shift2Start: envInt('FACTORY_SHIFT2_START', 14),  // 2pm
    shift2End:   envInt('FACTORY_SHIFT2_END',   22),  // 10pm
  },
  auth: {
    secret: env('AUTH_SECRET', env('NEXTAUTH_SECRET', 'dev-secret-change-me')),
    users: parseUsers(env('AUTH_USERS', 'admin:password')),
  },
}

function parseSubstitutes(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!raw) return map
  for (const pair of raw.split(',')) {
    const parts = pair.split('^').map(s => s.trim()).filter(Boolean)
    if (parts.length >= 2) map.set(parts[0], parts.slice(1))
  }
  return map
}

function parseUsers(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':')
    if (colonIdx > 0) {
      const user = pair.substring(0, colonIdx).trim()
      const pass = pair.substring(colonIdx + 1).trim()
      map.set(user, pass)
    }
  }
  return map
}
