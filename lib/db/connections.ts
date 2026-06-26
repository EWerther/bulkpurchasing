import sql from 'mssql'
import { config } from '@/lib/config'

type PoolName = keyof typeof config.db.pools

const pools = new Map<PoolName, sql.ConnectionPool>()

function parseServer(serverStr: string): { server: string; port?: number } {
  const [server, portStr] = serverStr.split(',')
  const port = portStr ? parseInt(portStr, 10) : undefined
  return { server, port }
}

function createPoolConfig(poolName: PoolName): sql.config {
  const poolDef = config.db.pools[poolName]
  const { server, port } = parseServer(poolDef.server)
  return {
    server,
    port,
    database: poolDef.database,
    user: poolDef.user,
    password: poolDef.password,
    options: {
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
      enableArithAbort: true,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    requestTimeout: 60000,
    connectionTimeout: 30000,
  }
}

export async function getPool(name: PoolName): Promise<sql.ConnectionPool> {
  const existing = pools.get(name)
  if (existing?.connected) return existing

  const pool = new sql.ConnectionPool(createPoolConfig(name))
  await pool.connect()
  pools.set(name, pool)
  return pool
}

export async function getCompanyPools(company: 'FTX' | 'SBYL') {
  if (company === 'FTX') {
    return {
      lcdata: await getPool('LCDataFTX'),
      customdata: await getPool('CustomDataFTX'),
    }
  } else {
    return {
      lcdata: await getPool('LCDataSBYL'),
      customdata: await getPool('CustomDataSBYL'),
    }
  }
}

export { sql }
