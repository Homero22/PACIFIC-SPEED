import fs from 'fs';
import path from 'path';
import pg from 'pg';
import {
  DEFAULT_FINANCIAL_CONFIG,
  TournamentFinancialConfig
} from '../shared/financialConfig.js';
import type {
  PaymentAuditRecord,
  ReferralRecord,
  SecurityAuditLog,
  TournamentRecord
} from '../shared/types.js';

interface LocalDatabaseSchema {
  config: TournamentFinancialConfig;
  tournament: TournamentRecord;
  referrals: ReferralRecord[];
  payments: PaymentAuditRecord[];
  security_logs: SecurityAuditLog[];
}

const LOCAL_DB_DIR = path.resolve('data');
const LOCAL_DB_PATH = path.join(LOCAL_DB_DIR, 'tournament_db.json');

function cleanEnv(val: string | undefined): string | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  const unquoted = trimmed.replace(/^["'](.*)["']$/, '$1').trim();
  return unquoted.length > 0 ? unquoted : undefined;
}

interface ResolvedPgConfig {
  config: pg.PoolConfig;
  source: string;
  hostDisplay: string;
  dbDisplay: string;
  userDisplay: string;
  portDisplay: number;
  isRemote: boolean;
}

function resolvePgConfig(): ResolvedPgConfig | null {
  // 1. Check all URL aliases
  const rawUrl =
    cleanEnv(process.env.DATABASE_URL) ||
    cleanEnv(process.env.POSTGRES_URL) ||
    cleanEnv(process.env.POSTGRESQL_URL) ||
    cleanEnv(process.env.DATABASE_PUBLIC_URL) ||
    cleanEnv(process.env.DATABASE_PRIVATE_URL) ||
    cleanEnv(process.env.DB_URL) ||
    cleanEnv(process.env.POSTGRES_PRISMA_URL);

  if (rawUrl) {
    const isLocal =
      rawUrl.includes('localhost') ||
      rawUrl.includes('127.0.0.1') ||
      rawUrl.includes('::1');

    let hostDisplay = 'remote-host';
    let dbDisplay = 'database';
    let userDisplay = 'user';
    let portDisplay = 5432;
    try {
      const parsed = new URL(rawUrl.replace(/^postgres(ql)?:/, 'http:'));
      hostDisplay = parsed.hostname || hostDisplay;
      portDisplay = parsed.port ? parseInt(parsed.port, 10) : 5432;
      dbDisplay = parsed.pathname.replace(/^\//, '') || dbDisplay;
      userDisplay = parsed.username || userDisplay;
    } catch {}

    const forceSsl = cleanEnv(process.env.PGSSLMODE) === 'require' || cleanEnv(process.env.DB_SSL) === 'true';
    const disableSsl = cleanEnv(process.env.PGSSLMODE) === 'disable' || cleanEnv(process.env.DB_SSL) === 'false';

    const ssl = disableSsl ? false : (forceSsl || !isLocal ? { rejectUnauthorized: false } : false);

    return {
      config: {
        connectionString: rawUrl,
        ssl
      },
      source: 'DATABASE_URL (o alias de URL)',
      hostDisplay,
      dbDisplay,
      userDisplay,
      portDisplay,
      isRemote: !isLocal
    };
  }

  // 2. Check discrete variables and aliases
  const host =
    cleanEnv(process.env.DB_HOST) ||
    cleanEnv(process.env.PGHOST) ||
    cleanEnv(process.env.POSTGRES_HOST) ||
    cleanEnv(process.env.DATABASE_HOST) ||
    cleanEnv(process.env.DB_HOSTNAME) ||
    cleanEnv(process.env.PG_HOST);

  const portRaw =
    cleanEnv(process.env.DB_PORT) ||
    cleanEnv(process.env.PGPORT) ||
    cleanEnv(process.env.POSTGRES_PORT) ||
    cleanEnv(process.env.DATABASE_PORT) ||
    cleanEnv(process.env.PG_PORT) ||
    '5432';

  const user =
    cleanEnv(process.env.DB_USERNAME) ||
    cleanEnv(process.env.DB_USER) ||
    cleanEnv(process.env.PGUSER) ||
    cleanEnv(process.env.POSTGRES_USER) ||
    cleanEnv(process.env.DATABASE_USER) ||
    cleanEnv(process.env.PG_USER) ||
    cleanEnv(process.env.DB_USER_NAME) ||
    (host ? 'postgres' : undefined);

  const password =
    cleanEnv(process.env.DB_PASSWORD) ||
    cleanEnv(process.env.DB_PASS) ||
    cleanEnv(process.env.PGPASSWORD) ||
    cleanEnv(process.env.POSTGRES_PASSWORD) ||
    cleanEnv(process.env.DATABASE_PASSWORD) ||
    cleanEnv(process.env.PG_PASSWORD) ||
    cleanEnv(process.env.DB_PWD);

  const database =
    cleanEnv(process.env.DB_DATABASE) ||
    cleanEnv(process.env.DB_NAME) ||
    cleanEnv(process.env.PGDATABASE) ||
    cleanEnv(process.env.POSTGRES_DB) ||
    cleanEnv(process.env.POSTGRES_DATABASE) ||
    cleanEnv(process.env.DATABASE_NAME) ||
    cleanEnv(process.env.PG_DATABASE) ||
    (host ? 'postgres' : undefined);

  if (host && user && database) {
    const port = parseInt(portRaw, 10) || 5432;
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1';

    const forceSsl = cleanEnv(process.env.PGSSLMODE) === 'require' || cleanEnv(process.env.DB_SSL) === 'true';
    const disableSsl = cleanEnv(process.env.PGSSLMODE) === 'disable' || cleanEnv(process.env.DB_SSL) === 'false';

    const ssl = disableSsl ? false : (forceSsl || !isLocal ? { rejectUnauthorized: false } : false);

    return {
      config: {
        host,
        port,
        user,
        password,
        database,
        ssl
      },
      source: 'Variables discretas (DB_HOST, DB_USER, DB_PASSWORD, DB_DATABASE, etc.)',
      hostDisplay: host,
      dbDisplay: database,
      userDisplay: user,
      portDisplay: port,
      isRemote: !isLocal
    };
  }

  return null;
}

export class DatabaseProvider {
  private pgPool: pg.Pool | null = null;
  private isPostgres = false;
  private isInitialized = false;
  private localData: LocalDatabaseSchema | null = null;
  private pgConfig: pg.PoolConfig | null = null;
  private currentDbName = 'local';
  private currentHostName = 'local';

  constructor() {
    this.initLocalStorage();
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;

    console.log('[DB] ========================================================');
    console.log('[DB] Evaluando configuración de base de datos...');

    const resolved = resolvePgConfig();

    if (!resolved) {
      console.log('[DB] ℹ️  No se detectaron credenciales de PostgreSQL en las variables de entorno.');
      console.log('[DB] Variables inspeccionadas: DATABASE_URL, POSTGRES_URL, DB_HOST, PGHOST, DB_USERNAME, PGUSER, DB_PASSWORD, DB_DATABASE, etc.');
      console.log('[DB] Modo activo: Almacenamiento local persistente (data/tournament_db.json).');
      console.log('[DB] ========================================================');
      this.isInitialized = true;
      return;
    }

    console.log(`[DB] Credenciales PostgreSQL detectadas vía: ${resolved.source}`);
    console.log(`[DB] Destino: Host="${resolved.hostDisplay}", Port=${resolved.portDisplay}, DB="${resolved.dbDisplay}", User="${resolved.userDisplay}", SSL=${Boolean(resolved.config.ssl)}`);
    console.log('[DB] Intentando conexión con PostgreSQL...');

    try {
      const { pool, finalConfig } = await this.connectWithSslNegotiation(resolved.config);
      this.pgPool = pool;
      this.pgConfig = finalConfig;
      this.isPostgres = true;
      this.currentDbName = resolved.dbDisplay;
      this.currentHostName = resolved.hostDisplay;

      await this.ensureDatabaseExists(resolved.dbDisplay);
      await this.initPostgresTables();

      console.log(`[DB] ✅ Conectado exitosamente a PostgreSQL ("${resolved.dbDisplay}" @ ${resolved.hostDisplay}:${resolved.portDisplay}). Tablas verificadas.`);
      console.log('[DB] ========================================================');
      this.isInitialized = true;
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[DB] ❌ Error conectando a PostgreSQL: ${errorMsg}`);

      const isRailway = Boolean(
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_SERVICE_ID ||
        process.env.RAILWAY_STATIC_URL
      );

      if (isRailway && (resolved.hostDisplay === 'localhost' || resolved.hostDisplay === '127.0.0.1')) {
        console.warn('[DB] 💡 NOTA PARA RAILWAY: Se detectó DB_HOST="localhost" dentro del contenedor de Railway.');
        console.warn('[DB] En Railway, cada servicio corre en un contenedor aislado. Para conectar a PostgreSQL:');
        console.warn('[DB]   1. En Railway crea un servicio PostgreSQL (+ New -> Database -> PostgreSQL).');
        console.warn('[DB]   2. En tu servicio web, vincula la variable DATABASE_URL provista por Railway.');
        console.warn('[DB]   3. O si usas una base externa (Supabase/Neon), coloca el HOST público o DATABASE_URL.');
      }

      console.warn('[DB] ⚠️  Activando fallback a almacenamiento local persistente (data/tournament_db.json).');
      console.log('[DB] ========================================================');

      this.isPostgres = false;
      if (this.pgPool) {
        await this.pgPool.end().catch(() => {});
        this.pgPool = null;
      }
      this.isInitialized = true;
    }
  }

  private async connectWithSslNegotiation(
    config: pg.PoolConfig
  ): Promise<{ pool: pg.Pool; finalConfig: pg.PoolConfig }> {
    let currentConfig: pg.PoolConfig = { ...config, connectionTimeoutMillis: 10000 };
    let pool = new pg.Pool(currentConfig);

    try {
      const client = await pool.connect();
      client.release();
      return { pool, finalConfig: currentConfig };
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();

      // Case 1: Server does not support SSL (e.g. local or internal Docker network in Railway)
      if (
        msg.includes('server does not support ssl') ||
        msg.includes('does not support ssl') ||
        msg.includes('ssl not supported')
      ) {
        console.log('[DB] El servidor no admite SSL. Reintentando con SSL desactivado...');
        await pool.end().catch(() => {});
        currentConfig = { ...currentConfig, ssl: false };
        if (currentConfig.connectionString) {
          currentConfig.connectionString = currentConfig.connectionString.replace(/([?&])sslmode=[^&]+/, '$1sslmode=disable');
        }
        pool = new pg.Pool(currentConfig);
        const client = await pool.connect();
        client.release();
        return { pool, finalConfig: currentConfig };
      }

      // Case 2: Server requires SSL (e.g. Neon, Supabase, Railway Public Proxy, RDS)
      if (
        msg.includes('no pg_hba.conf entry') ||
        msg.includes('ssl off') ||
        msg.includes('ssl connection is required') ||
        msg.includes('require ssl') ||
        msg.includes('encryption required')
      ) {
        console.log('[DB] El servidor requiere SSL. Reintentando con SSL activado...');
        await pool.end().catch(() => {});
        currentConfig = { ...currentConfig, ssl: { rejectUnauthorized: false } };
        pool = new pg.Pool(currentConfig);
        const client = await pool.connect();
        client.release();
        return { pool, finalConfig: currentConfig };
      }

      await pool.end().catch(() => {});
      throw err;
    }
  }

  private async ensureDatabaseExists(targetDb: string): Promise<void> {
    if (!this.pgPool || !this.pgConfig) return;

    try {
      const client = await this.pgPool.connect();
      client.release();
      return;
    } catch (err: any) {
      if (err && err.code === '3D000') {
        console.log(`[DB] Base de datos "${targetDb}" no existe. Intentando crearla automáticamente...`);
        try {
          const adminConfig: pg.PoolConfig = {
            ...this.pgConfig,
            database: 'postgres',
            connectionTimeoutMillis: 8000
          };
          if (adminConfig.connectionString) {
            adminConfig.connectionString = adminConfig.connectionString.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
          }
          const adminClient = new pg.Client(adminConfig);
          await adminClient.connect();
          try {
            if (/^[a-zA-Z0-9_]+$/.test(targetDb)) {
              await adminClient.query(`CREATE DATABASE "${targetDb}"`);
              console.log(`[DB] Base de datos "${targetDb}" creada exitosamente.`);
            } else {
              throw new Error(`Nombre de base de datos no válido: ${targetDb}`);
            }
          } finally {
            await adminClient.end().catch(() => {});
          }

          if (this.pgPool) {
            await this.pgPool.end().catch(() => {});
          }
          this.pgPool = new pg.Pool(this.pgConfig);
          const client = await this.pgPool.connect();
          client.release();
        } catch (adminErr: any) {
          console.warn(`[DB] Nota: No se pudo auto-crear la base de datos "${targetDb}" (${adminErr?.message}). Procediendo si es servicio administrado.`);
          throw adminErr;
        }
      } else {
        throw err;
      }
    }
  }

  public isPostgresActive(): boolean {
    return this.isPostgres;
  }

  public getDatabaseInfo(): { type: 'postgresql' | 'local_json'; host: string; database: string } {
    if (this.isPostgres) {
      return {
        type: 'postgresql',
        host: this.currentHostName,
        database: this.currentDbName
      };
    }
    return {
      type: 'local_json',
      host: 'local',
      database: 'data/tournament_db.json'
    };
  }

  private initLocalStorage(): void {
    if (!fs.existsSync(LOCAL_DB_DIR)) {
      fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
    }

    if (fs.existsSync(LOCAL_DB_PATH)) {
      try {
        const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
        this.localData = JSON.parse(raw) as LocalDatabaseSchema;
        return;
      } catch {
        // Fall through to default setup
      }
    }

    const defaultTournament: TournamentRecord = {
      id: 'tourney-default-01',
      name: 'PACIFIC SPEED: OVERDRIVE - TEMPORADA INAUGURAL',
      status: 'active',
      entry_fee_usd: DEFAULT_FINANCIAL_CONFIG.entry_fee_per_pair,
      max_couples: DEFAULT_FINANCIAL_CONFIG.max_couples_limit,
      registered_couples_count: 0,
      accumulated_prize_pool: 0,
      accumulated_charity_amount: 0,
      accumulated_operating_margin: 0,
      config_snapshot: DEFAULT_FINANCIAL_CONFIG,
      created_at: new Date().toISOString()
    };

    const seedReferrals: ReferralRecord[] = [
      {
        id: 'ref-partner-01',
        referral_code: 'SPEED2026',
        collaborator_name: 'ESCUADRON VORTEX MEDIA',
        collaborator_payphone_number: '+593991234567',
        total_couples_referred: 3,
        accumulated_earnings_usd: 1.74,
        settled_earnings_usd: 0.0,
        pending_earnings_usd: 1.74,
        created_at: new Date().toISOString()
      },
      {
        id: 'ref-partner-02',
        referral_code: 'TIKTOKRUN',
        collaborator_name: 'STREAMER JAEGER TOP',
        collaborator_payphone_number: '+593987654321',
        total_couples_referred: 1,
        accumulated_earnings_usd: 0.58,
        settled_earnings_usd: 0.0,
        pending_earnings_usd: 0.58,
        created_at: new Date().toISOString()
      }
    ];

    this.localData = {
      config: DEFAULT_FINANCIAL_CONFIG,
      tournament: defaultTournament,
      referrals: seedReferrals,
      payments: [],
      security_logs: []
    };

    this.persistLocalData();
  }

  private persistLocalData(): void {
    if (!this.localData) return;
    try {
      fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(this.localData, null, 2), 'utf8');
    } catch (err) {
      console.error('[DB] Failed to persist local tournament database:', err);
    }
  }

  private async initPostgresTables(): Promise<void> {
    if (!this.pgPool) return;
    const client = await this.pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tournament_configs (
          id VARCHAR(50) PRIMARY KEY,
          config_json JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tournaments (
          id VARCHAR(100) PRIMARY KEY,
          name VARCHAR(150) NOT NULL,
          status VARCHAR(30) NOT NULL,
          entry_fee_usd DECIMAL(10,2) NOT NULL,
          max_couples INT NOT NULL,
          registered_couples_count INT DEFAULT 0,
          accumulated_prize_pool DECIMAL(10,2) DEFAULT 0.00,
          accumulated_charity_amount DECIMAL(10,2) DEFAULT 0.00,
          accumulated_operating_margin DECIMAL(10,2) DEFAULT 0.00,
          config_snapshot_json JSONB NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS referrals (
          id VARCHAR(100) PRIMARY KEY,
          referral_code VARCHAR(50) UNIQUE NOT NULL,
          collaborator_name VARCHAR(100) NOT NULL,
          collaborator_payphone_number VARCHAR(30),
          total_couples_referred INT DEFAULT 0,
          accumulated_earnings_usd DECIMAL(10,2) DEFAULT 0.00,
          settled_earnings_usd DECIMAL(10,2) DEFAULT 0.00,
          pending_earnings_usd DECIMAL(10,2) DEFAULT 0.00,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS payments_audit (
          id VARCHAR(100) PRIMARY KEY,
          payphone_transaction_id VARCHAR(100) UNIQUE NOT NULL,
          tournament_id VARCHAR(100) NOT NULL,
          referral_id VARCHAR(100),
          referral_code VARCHAR(50),
          pair_driver_name VARCHAR(100) NOT NULL,
          pair_navigator_name VARCHAR(100) NOT NULL,
          gross_amount DECIMAL(10,2) NOT NULL,
          payphone_fee DECIMAL(10,2) NOT NULL,
          prize_pool_share DECIMAL(10,2) NOT NULL,
          charity_share DECIMAL(10,2) NOT NULL,
          developer_share DECIMAL(10,2) NOT NULL,
          collaborator_share DECIMAL(10,2) NOT NULL,
          status VARCHAR(30) NOT NULL,
          raw_payload_json TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Seed 1: Active Configuration
      const cfgRes = await client.query('SELECT id FROM tournament_configs WHERE id = $1', ['active_config']);
      if (cfgRes.rows.length === 0) {
        await client.query(
          'INSERT INTO tournament_configs (id, config_json, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
          ['active_config', JSON.stringify(DEFAULT_FINANCIAL_CONFIG)]
        );
      }

      // Seed 2: Default Tournament
      const tourneyRes = await client.query('SELECT id FROM tournaments LIMIT 1');
      if (tourneyRes.rows.length === 0) {
        const defaultTourney = this.localData?.tournament || {
          id: 'tourney-default-01',
          name: 'PACIFIC SPEED: OVERDRIVE - TEMPORADA INAUGURAL',
          status: 'active',
          entry_fee_usd: DEFAULT_FINANCIAL_CONFIG.entry_fee_per_pair,
          max_couples: DEFAULT_FINANCIAL_CONFIG.max_couples_limit,
          registered_couples_count: 0,
          accumulated_prize_pool: 0,
          accumulated_charity_amount: 0,
          accumulated_operating_margin: 0,
          config_snapshot: DEFAULT_FINANCIAL_CONFIG,
          created_at: new Date().toISOString()
        };
        await client.query(
          `INSERT INTO tournaments (
            id, name, status, entry_fee_usd, max_couples, registered_couples_count,
            accumulated_prize_pool, accumulated_charity_amount, accumulated_operating_margin,
            config_snapshot_json, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            defaultTourney.id,
            defaultTourney.name,
            defaultTourney.status,
            defaultTourney.entry_fee_usd,
            defaultTourney.max_couples,
            defaultTourney.registered_couples_count,
            defaultTourney.accumulated_prize_pool,
            defaultTourney.accumulated_charity_amount,
            defaultTourney.accumulated_operating_margin,
            JSON.stringify(defaultTourney.config_snapshot),
            defaultTourney.created_at
          ]
        );
      }

      // Seed 3: Default Referrals
      const refRes = await client.query('SELECT id FROM referrals LIMIT 1');
      if (refRes.rows.length === 0) {
        const seedRefs = this.localData?.referrals?.length ? this.localData.referrals : [
          {
            id: 'ref-partner-01',
            referral_code: 'SPEED2026',
            collaborator_name: 'ESCUADRON VORTEX MEDIA',
            collaborator_payphone_number: '+593991234567',
            total_couples_referred: 3,
            accumulated_earnings_usd: 1.74,
            settled_earnings_usd: 0.0,
            pending_earnings_usd: 1.74,
            created_at: new Date().toISOString()
          },
          {
            id: 'ref-partner-02',
            referral_code: 'TIKTOKRUN',
            collaborator_name: 'STREAMER JAEGER TOP',
            collaborator_payphone_number: '+593987654321',
            total_couples_referred: 1,
            accumulated_earnings_usd: 0.58,
            settled_earnings_usd: 0.0,
            pending_earnings_usd: 0.58,
            created_at: new Date().toISOString()
          }
        ];

        for (const ref of seedRefs) {
          await client.query(
            `INSERT INTO referrals (
              id, referral_code, collaborator_name, collaborator_payphone_number,
              total_couples_referred, accumulated_earnings_usd, settled_earnings_usd,
              pending_earnings_usd, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO NOTHING`,
            [
              ref.id,
              ref.referral_code.toUpperCase(),
              ref.collaborator_name,
              ref.collaborator_payphone_number,
              ref.total_couples_referred,
              ref.accumulated_earnings_usd,
              ref.settled_earnings_usd,
              ref.pending_earnings_usd,
              ref.created_at
            ]
          );
        }
      }
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------
  // Data Access Methods
  // -------------------------------------------------------------

  public async getTournamentConfig(): Promise<TournamentFinancialConfig> {
    if (this.isPostgres && this.pgPool) {
      const res = await this.pgPool.query(
        'SELECT config_json FROM tournament_configs WHERE id = $1',
        ['active_config']
      );
      if (res.rows.length > 0) {
        return res.rows[0].config_json as TournamentFinancialConfig;
      }
    }
    return this.localData?.config || DEFAULT_FINANCIAL_CONFIG;
  }

  public async saveTournamentConfig(config: TournamentFinancialConfig): Promise<void> {
    if (this.isPostgres && this.pgPool) {
      await this.pgPool.query(
        `INSERT INTO tournament_configs (id, config_json, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET config_json = $2, updated_at = CURRENT_TIMESTAMP`,
        ['active_config', JSON.stringify(config)]
      );
    }
    if (this.localData) {
      this.localData.config = config;
      this.persistLocalData();
    }
  }

  public async getActiveTournament(): Promise<TournamentRecord> {
    if (this.isPostgres && this.pgPool) {
      const res = await this.pgPool.query(
        `SELECT id, name, status, entry_fee_usd, max_couples, registered_couples_count,
                accumulated_prize_pool, accumulated_charity_amount, accumulated_operating_margin,
                config_snapshot_json, created_at, completed_at
         FROM tournaments WHERE status IN ('active', 'in_progress', 'draft')
         ORDER BY created_at DESC LIMIT 1`
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          entry_fee_usd: parseFloat(row.entry_fee_usd),
          max_couples: parseInt(row.max_couples, 10),
          registered_couples_count: parseInt(row.registered_couples_count || 0, 10),
          accumulated_prize_pool: parseFloat(row.accumulated_prize_pool || 0),
          accumulated_charity_amount: parseFloat(row.accumulated_charity_amount || 0),
          accumulated_operating_margin: parseFloat(row.accumulated_operating_margin || 0),
          config_snapshot: row.config_snapshot_json,
          created_at: row.created_at,
          completed_at: row.completed_at
        };
      }
    }
    return (
      this.localData?.tournament || {
        id: 'tourney-default-01',
        name: 'PACIFIC SPEED: OVERDRIVE - TEMPORADA INAUGURAL',
        status: 'active',
        entry_fee_usd: 10.0,
        max_couples: 50,
        registered_couples_count: 0,
        accumulated_prize_pool: 0,
        accumulated_charity_amount: 0,
        accumulated_operating_margin: 0,
        config_snapshot: DEFAULT_FINANCIAL_CONFIG,
        created_at: new Date().toISOString()
      }
    );
  }

  public async saveTournament(tourney: TournamentRecord): Promise<void> {
    if (this.isPostgres && this.pgPool) {
      await this.pgPool.query(
        `INSERT INTO tournaments (
          id, name, status, entry_fee_usd, max_couples, registered_couples_count,
          accumulated_prize_pool, accumulated_charity_amount, accumulated_operating_margin,
          config_snapshot_json, created_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          name = $2, status = $3, entry_fee_usd = $4, max_couples = $5,
          registered_couples_count = $6, accumulated_prize_pool = $7,
          accumulated_charity_amount = $8, accumulated_operating_margin = $9,
          config_snapshot_json = $10, completed_at = $12`,
        [
          tourney.id,
          tourney.name,
          tourney.status,
          tourney.entry_fee_usd,
          tourney.max_couples,
          tourney.registered_couples_count,
          tourney.accumulated_prize_pool,
          tourney.accumulated_charity_amount,
          tourney.accumulated_operating_margin,
          JSON.stringify(tourney.config_snapshot),
          tourney.created_at,
          tourney.completed_at || null
        ]
      );
    }
    if (this.localData) {
      this.localData.tournament = tourney;
      this.persistLocalData();
    }
  }

  public async getReferralByCode(codeRaw: string): Promise<ReferralRecord | null> {
    const code = (codeRaw || '').trim().toUpperCase();
    if (!code) return null;

    if (this.isPostgres && this.pgPool) {
      const res = await this.pgPool.query(
        'SELECT * FROM referrals WHERE UPPER(referral_code) = $1',
        [code]
      );
      if (res.rows.length > 0) {
        const r = res.rows[0];
        return {
          id: r.id,
          referral_code: r.referral_code,
          collaborator_name: r.collaborator_name,
          collaborator_payphone_number: r.collaborator_payphone_number,
          total_couples_referred: parseInt(r.total_couples_referred || 0, 10),
          accumulated_earnings_usd: parseFloat(r.accumulated_earnings_usd || 0),
          settled_earnings_usd: parseFloat(r.settled_earnings_usd || 0),
          pending_earnings_usd: parseFloat(r.pending_earnings_usd || 0),
          created_at: r.created_at
        };
      }
      return null;
    }

    return (
      this.localData?.referrals.find((r) => r.referral_code.toUpperCase() === code) || null
    );
  }

  public async getReferralById(id: string): Promise<ReferralRecord | null> {
    if (this.isPostgres && this.pgPool) {
      const res = await this.pgPool.query('SELECT * FROM referrals WHERE id = $1', [id]);
      if (res.rows.length > 0) {
        const r = res.rows[0];
        return {
          id: r.id,
          referral_code: r.referral_code,
          collaborator_name: r.collaborator_name,
          collaborator_payphone_number: r.collaborator_payphone_number,
          total_couples_referred: parseInt(r.total_couples_referred || 0, 10),
          accumulated_earnings_usd: parseFloat(r.accumulated_earnings_usd || 0),
          settled_earnings_usd: parseFloat(r.settled_earnings_usd || 0),
          pending_earnings_usd: parseFloat(r.pending_earnings_usd || 0),
          created_at: r.created_at
        };
      }
      return null;
    }
    return this.localData?.referrals.find((r) => r.id === id) || null;
  }

  public async saveReferral(ref: ReferralRecord): Promise<void> {
    if (this.isPostgres && this.pgPool) {
      await this.pgPool.query(
        `INSERT INTO referrals (
          id, referral_code, collaborator_name, collaborator_payphone_number,
          total_couples_referred, accumulated_earnings_usd, settled_earnings_usd,
          pending_earnings_usd, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          referral_code = $2, collaborator_name = $3, collaborator_payphone_number = $4,
          total_couples_referred = $5, accumulated_earnings_usd = $6,
          settled_earnings_usd = $7, pending_earnings_usd = $8`,
        [
          ref.id,
          ref.referral_code.toUpperCase(),
          ref.collaborator_name,
          ref.collaborator_payphone_number,
          ref.total_couples_referred,
          ref.accumulated_earnings_usd,
          ref.settled_earnings_usd,
          ref.pending_earnings_usd,
          ref.created_at
        ]
      );
    }
    if (this.localData) {
      const idx = this.localData.referrals.findIndex((r) => r.id === ref.id);
      if (idx >= 0) {
        this.localData.referrals[idx] = ref;
      } else {
        this.localData.referrals.push(ref);
      }
      this.persistLocalData();
    }
  }

  public async listReferrals(): Promise<ReferralRecord[]> {
    if (this.isPostgres && this.pgPool) {
      const res = await this.pgPool.query(
        'SELECT * FROM referrals ORDER BY accumulated_earnings_usd DESC'
      );
      return res.rows.map((r) => ({
        id: r.id,
        referral_code: r.referral_code,
        collaborator_name: r.collaborator_name,
        collaborator_payphone_number: r.collaborator_payphone_number,
        total_couples_referred: parseInt(r.total_couples_referred || 0, 10),
        accumulated_earnings_usd: parseFloat(r.accumulated_earnings_usd || 0),
        settled_earnings_usd: parseFloat(r.settled_earnings_usd || 0),
        pending_earnings_usd: parseFloat(r.pending_earnings_usd || 0),
        created_at: r.created_at
      }));
    }
    return [...(this.localData?.referrals || [])];
  }

  public async savePaymentAudit(audit: PaymentAuditRecord): Promise<void> {
    if (this.isPostgres && this.pgPool) {
      await this.pgPool.query(
        `INSERT INTO payments_audit (
          id, payphone_transaction_id, tournament_id, referral_id, referral_code,
          pair_driver_name, pair_navigator_name, gross_amount, payphone_fee,
          prize_pool_share, charity_share, developer_share, collaborator_share,
          status, raw_payload_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO NOTHING`,
        [
          audit.id,
          audit.payphone_transaction_id,
          audit.tournament_id,
          audit.referral_id,
          audit.referral_code,
          audit.pair_driver_name,
          audit.pair_navigator_name,
          audit.gross_amount,
          audit.payphone_fee,
          audit.prize_pool_share,
          audit.charity_share,
          audit.developer_share,
          audit.collaborator_share,
          audit.status,
          audit.raw_payload_json || null,
          audit.created_at
        ]
      );
    }
    if (this.localData) {
      this.localData.payments.unshift(audit);
      if (this.localData.payments.length > 250) {
        this.localData.payments.length = 250;
      }
      this.persistLocalData();
    }
  }

  public async listPaymentAudits(): Promise<PaymentAuditRecord[]> {
    if (this.isPostgres && this.pgPool) {
      const res = await this.pgPool.query(
        'SELECT * FROM payments_audit ORDER BY created_at DESC LIMIT 100'
      );
      return res.rows.map((r) => ({
        id: r.id,
        payphone_transaction_id: r.payphone_transaction_id,
        tournament_id: r.tournament_id,
        referral_id: r.referral_id,
        referral_code: r.referral_code,
        pair_driver_name: r.pair_driver_name,
        pair_navigator_name: r.pair_navigator_name,
        gross_amount: parseFloat(r.gross_amount),
        payphone_fee: parseFloat(r.payphone_fee),
        prize_pool_share: parseFloat(r.prize_pool_share),
        charity_share: parseFloat(r.charity_share),
        developer_share: parseFloat(r.developer_share),
        collaborator_share: parseFloat(r.collaborator_share),
        status: r.status,
        raw_payload_json: r.raw_payload_json,
        created_at: r.created_at
      }));
    }
    return [...(this.localData?.payments || [])];
  }
}

export const dbProvider = new DatabaseProvider();
