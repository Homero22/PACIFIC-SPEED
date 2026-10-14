import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import {
  DEFAULT_FINANCIAL_CONFIG,
  round2,
  TournamentFinancialConfig,
  TransactionCalculationResult
} from '../shared/financialConfig.js';
import type {
  ConfigChangeRecord,
  PaymentAuditRecord,
  PendingRegistrationRecord,
  ReferralRecord,
  SecurityAuditLog,
  TournamentRecord
} from '../shared/types.js';
import { isProductionEnv } from './runtimeConfig.js';

interface LocalDatabaseSchema {
  config: TournamentFinancialConfig;
  tournament: TournamentRecord;
  referrals: ReferralRecord[];
  payments: PaymentAuditRecord[];
  security_logs: SecurityAuditLog[];
  pending_registrations?: PendingRegistrationRecord[];
  config_changes?: ConfigChangeRecord[];
}


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
    cleanEnv(process.env.DB_SERVER) ||
    cleanEnv(process.env.DB_HOST) ||
    cleanEnv(process.env.PGHOST) ||
    cleanEnv(process.env.POSTGRES_HOST) ||
    cleanEnv(process.env.DATABASE_SERVER) ||
    cleanEnv(process.env.DATABASE_HOST) ||
    cleanEnv(process.env.DB_HOSTNAME) ||
    cleanEnv(process.env.PG_HOST) ||
    cleanEnv(process.env.SERVER) ||
    cleanEnv(process.env.HOST);

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

export class DatabaseUnavailableError extends Error {
  constructor(message = 'Base de datos no disponible temporalmente. Intenta nuevamente en unos minutos.') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

export type DatabaseMode = 'uninitialized' | 'postgres' | 'local' | 'unavailable';

export interface ApplyPaymentInput {
  client_transaction_id: string;
  payphone_transaction_id: string;
  tournament_id: string;
  referral: { id: string; referral_code: string } | null;
  splits: TransactionCalculationResult;
  raw_payload_json: string;
}

export type ApplyPaymentResult =
  | { status: 'applied'; audit: PaymentAuditRecord; tournament: TournamentRecord }
  | { status: 'duplicate'; audit: PaymentAuditRecord }
  | { status: 'not_pending'; message: string }
  | { status: 'tournament_full'; message: string };

export function generatePassToken(): string {
  // 128-bit random pass, formatted for humans: PS-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
  const hex = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `PS-${hex.match(/.{4}/g)!.join('-')}`;
}

const PG_RETRY_INTERVAL_MS = 15000;

const SEED_LOCAL_REFERRALS: ReferralRecord[] = [
  {
    id: 'ref-partner-01',
    referral_code: 'SPEED2026',
    collaborator_name: 'ESCUADRON VORTEX MEDIA',
    collaborator_payphone_number: '+593991234567',
    total_couples_referred: 0,
    accumulated_earnings_usd: 0,
    settled_earnings_usd: 0,
    pending_earnings_usd: 0,
    created_at: new Date().toISOString()
  }
];

function defaultTournamentRecord(config: TournamentFinancialConfig = DEFAULT_FINANCIAL_CONFIG): TournamentRecord {
  return {
    id: 'tourney-default-01',
    name: 'PACIFIC SPEED: OVERDRIVE - TEMPORADA INAUGURAL',
    status: 'active',
    entry_fee_usd: config.entry_fee_per_pair,
    max_couples: config.max_couples_limit,
    registered_couples_count: 0,
    accumulated_prize_pool: 0,
    accumulated_charity_amount: 0,
    accumulated_operating_margin: 0,
    config_snapshot: config,
    created_at: new Date().toISOString()
  };
}

function mapReferralRow(r: any): ReferralRecord {
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

function mapAuditRow(r: any): PaymentAuditRecord {
  return {
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
    pass_token: r.pass_token || undefined,
    client_transaction_id: r.client_transaction_id || undefined,
    created_at: r.created_at
  };
}

function mapTournamentRow(row: any): TournamentRecord {
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

function mapPendingRow(row: any): PendingRegistrationRecord {
  return {
    client_transaction_id: row.client_transaction_id,
    driver_name: row.driver_name,
    navigator_name: row.navigator_name,
    referral_code: row.referral_code || undefined,
    phone: row.phone || undefined,
    amount_usd: parseFloat(row.amount_usd),
    status: row.status,
    tournament_id: row.tournament_id || undefined,
    created_at: row.created_at,
    room_code: row.room_code || undefined,
    config_snapshot: row.config_snapshot_json || undefined
  };
}

function mapConfigChangeRow(row: any): ConfigChangeRecord {
  return {
    id: row.id,
    changed_at: new Date(row.changed_at).toISOString(),
    admin_ip: row.admin_ip,
    forced: Boolean(row.forced),
    reason: row.reason || null,
    registered_couples_at_change: parseInt(row.registered_couples_at_change || 0, 10),
    changes: row.changes_json || []
  };
}

export class ConfigLockConflictError extends Error {}

export class DatabaseProvider {
  private pgPool: pg.Pool | null = null;
  private mode: DatabaseMode = 'uninitialized';
  private hasPgCredentials = false;
  private unavailableReason = '';
  private retryTimer: NodeJS.Timeout | null = null;
  private localData: LocalDatabaseSchema | null = null;
  private pgConfig: pg.PoolConfig | null = null;
  private currentDbName = 'local';
  private currentHostName = 'local';
  constructor(private readonly options: { localDbPath?: string } = {}) {}

  private get localDbPath(): string {
    return (
      this.options.localDbPath || cleanEnv(process.env.TOURNAMENT_DB_PATH) || path.resolve('data', 'tournament_db.json')
    );
  }

  public async init(): Promise<void> {
    if (this.mode !== 'uninitialized') return;

    console.log('[DB] ========================================================');
    console.log('[DB] Evaluando configuración de base de datos...');

    const resolved = resolvePgConfig();

    if (!resolved) {
      if (isProductionEnv()) {
        // A production instance must never keep money in an ephemeral local JSON file
        this.mode = 'unavailable';
        this.unavailableReason = 'Sin credenciales de PostgreSQL en producción.';
        console.error('[DB] ❌ No hay credenciales de PostgreSQL en producción. Pagos e inscripciones deshabilitados (503).');
        console.log('[DB] ========================================================');
        return;
      }
      console.log('[DB] ℹ️  No se detectaron credenciales de PostgreSQL en las variables de entorno.');
      console.log('[DB] Modo activo: Almacenamiento local de desarrollo (' + this.localDbPath + ').');
      console.log('[DB] ========================================================');
      this.initLocalStorage();
      return;
    }

    this.hasPgCredentials = true;
    console.log(`[DB] Credenciales PostgreSQL detectadas vía: ${resolved.source}`);
    console.log(`[DB] Destino: Host="${resolved.hostDisplay}", Port=${resolved.portDisplay}, DB="${resolved.dbDisplay}", User="${resolved.userDisplay}", SSL=${Boolean(resolved.config.ssl)}`);
    await this.connectPostgres(resolved);
  }

  private async connectPostgres(resolved: ResolvedPgConfig): Promise<void> {
    console.log('[DB] Intentando conexión con PostgreSQL...');
    try {
      const { pool, finalConfig } = await this.connectWithSslNegotiation(resolved.config);
      pool.on('error', (err) => {
        console.warn('[DB] ⚠️ Aviso de cliente PostgreSQL inactivo (manejado automáticamente):', err.message);
      });
      this.pgPool = pool;
      this.pgConfig = finalConfig;
      this.currentDbName = resolved.dbDisplay;
      this.currentHostName = resolved.hostDisplay;

      await this.ensureDatabaseExists(resolved.dbDisplay);
      await this.initPostgresTables();

      this.mode = 'postgres';
      this.unavailableReason = '';
      console.log(`[DB] ✅ Conectado exitosamente a PostgreSQL ("${resolved.dbDisplay}" @ ${resolved.hostDisplay}:${resolved.portDisplay}). Tablas verificadas.`);
      console.log('[DB] ========================================================');
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[DB] ❌ Error conectando a PostgreSQL: ${errorMsg}`);

      const isRailway = Boolean(
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_SERVICE_ID ||
        process.env.RAILWAY_STATIC_URL
      );

      if (isRailway && (resolved.hostDisplay === 'localhost' || resolved.hostDisplay === '127.0.0.1')) {
        console.warn('[DB] NOTA PARA RAILWAY: Se detectó DB_HOST="localhost" dentro del contenedor de Railway.');
        console.warn('[DB] En Railway, cada servicio corre en un contenedor aislado. Para conectar a PostgreSQL:');
        console.warn('[DB]   1. En Railway crea un servicio PostgreSQL (+ New -> Database -> PostgreSQL).');
        console.warn('[DB]   2. En tu servicio web, vincula la variable DATABASE_URL provista por Railway.');
        console.warn('[DB]   3. O si usas una base externa (Supabase/Neon), coloca el HOST público o DATABASE_URL.');
      }

      // No silent fallback to local JSON: payment endpoints answer 503 until PostgreSQL is back
      console.warn(`[DB] [AVISO] PostgreSQL no disponible. Endpoints de pago responderán 503. Reintento en ${PG_RETRY_INTERVAL_MS / 1000}s.`);
      console.log('[DB] ========================================================');

      this.mode = 'unavailable';
      this.unavailableReason = errorMsg;
      if (this.pgPool) {
        await this.pgPool.end().catch(() => {});
        this.pgPool = null;
      }
      this.scheduleReconnect(resolved);
    }
  }

  private scheduleReconnect(resolved: ResolvedPgConfig): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectPostgres(resolved);
    }, PG_RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  private async connectWithSslNegotiation(
    config: pg.PoolConfig
  ): Promise<{ pool: pg.Pool; finalConfig: pg.PoolConfig }> {
    let currentConfig: pg.PoolConfig = {
      ...config,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
      max: 20
    };
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
          this.pgPool.on('error', (err) => {
            console.warn('[DB] ⚠️ Aviso de cliente PostgreSQL inactivo (manejado automáticamente):', err.message);
          });
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
    return this.mode === 'postgres';
  }

  /**
   * True when reads/writes can be served (PostgreSQL connected, or local dev storage).
   */
  public isAvailable(): boolean {
    if (this.mode === 'postgres' || this.mode === 'local') return true;
    if (this.mode === 'uninitialized') return !this.hasPgCredentials && !resolvePgConfig() && !isProductionEnv();
    return false;
  }

  public getDatabaseInfo(): { type: 'postgresql' | 'local_json' | 'unavailable'; host: string; database: string } {
    if (this.mode === 'postgres') {
      return {
        type: 'postgresql',
        host: this.currentHostName,
        database: this.currentDbName
      };
    }
    if (this.mode === 'unavailable') {
      return { type: 'unavailable', host: this.currentHostName, database: this.currentDbName };
    }
    return {
      type: 'local_json',
      host: 'local',
      database: path.basename(this.localDbPath)
    };
  }

  /**
   * Returns the PostgreSQL pool, or null when running on local dev storage.
   * Throws DatabaseUnavailableError when PostgreSQL is configured but not reachable.
   */
  private backend(): pg.Pool | null {
    if (this.mode === 'postgres' && this.pgPool) return this.pgPool;
    if (this.mode === 'local') return null;
    if (this.mode === 'uninitialized' && this.isAvailable()) {
      // Lazy local mode (tests / scripts that never call init())
      this.initLocalStorage();
      return null;
    }
    throw new DatabaseUnavailableError(
      this.unavailableReason ? `Base de datos no disponible: ${this.unavailableReason}` : undefined
    );
  }

  private local(): LocalDatabaseSchema {
    if (!this.localData) this.initLocalStorage();
    return this.localData!;
  }

  private initLocalStorage(): void {
    this.mode = 'local';
    if (this.localData) return;
    const dir = path.dirname(this.localDbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.localDbPath)) {
      try {
        const raw = fs.readFileSync(this.localDbPath, 'utf8');
        this.localData = JSON.parse(raw) as LocalDatabaseSchema;
        if (!this.localData.pending_registrations) {
          this.localData.pending_registrations = [];
        }
        return;
      } catch {
        // Fall through to default setup
      }
    }

    this.localData = {
      config: DEFAULT_FINANCIAL_CONFIG,
      tournament: defaultTournamentRecord(),
      referrals: SEED_LOCAL_REFERRALS.map((r) => ({ ...r })),
      payments: [],
      security_logs: [],
      pending_registrations: []
    };

    this.persistLocalData();
  }

  private persistLocalData(): void {
    if (!this.localData) return;
    try {
      fs.writeFileSync(this.localDbPath, JSON.stringify(this.localData, null, 2), 'utf8');
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

        CREATE TABLE IF NOT EXISTS pending_registrations (
          client_transaction_id VARCHAR(100) PRIMARY KEY,
          driver_name VARCHAR(100) NOT NULL,
          navigator_name VARCHAR(100) NOT NULL,
          referral_code VARCHAR(50),
          phone VARCHAR(50),
          amount_usd DECIMAL(10,2) NOT NULL,
          status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Tournament pass: random token bound to the paid pair and tournament
        ALTER TABLE payments_audit ADD COLUMN IF NOT EXISTS pass_token VARCHAR(64);
        CREATE UNIQUE INDEX IF NOT EXISTS payments_audit_pass_token_key ON payments_audit (pass_token);
        ALTER TABLE payments_audit ADD COLUMN IF NOT EXISTS client_transaction_id VARCHAR(100);
        ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS tournament_id VARCHAR(100);
        -- Room the payer was in, so the Payphone return lands in the same room
        ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS room_code VARCHAR(20);
        -- Config in force when the payment link was created (the split uses it)
        ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS config_snapshot_json JSONB;

        CREATE TABLE IF NOT EXISTS config_changes (
          id VARCHAR(100) PRIMARY KEY,
          changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          admin_ip VARCHAR(64) NOT NULL,
          forced BOOLEAN NOT NULL DEFAULT FALSE,
          reason TEXT,
          registered_couples_at_change INT NOT NULL DEFAULT 0,
          changes_json JSONB NOT NULL
        );
      `);

      // Backfill pass tokens for payments approved before tokens existed (admin can hand them out)
      const missing = await client.query(
        "SELECT id FROM payments_audit WHERE pass_token IS NULL AND status = 'APPROVED'"
      );
      for (const row of missing.rows) {
        await client.query('UPDATE payments_audit SET pass_token = $1 WHERE id = $2 AND pass_token IS NULL', [
          generatePassToken(),
          row.id
        ]);
      }

      // Seed 1: Active Configuration
      const cfgRes = await client.query('SELECT id FROM tournament_configs WHERE id = $1', ['active_config']);
      if (cfgRes.rows.length === 0) {
        await client.query(
          'INSERT INTO tournament_configs (id, config_json, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
          ['active_config', JSON.stringify(DEFAULT_FINANCIAL_CONFIG)]
        );
      }

      // Seed 2: Default Tournament (no demo referrals with fake earnings in PostgreSQL)
      const tourneyRes = await client.query('SELECT id FROM tournaments LIMIT 1');
      if (tourneyRes.rows.length === 0) {
        const defaultTourney = defaultTournamentRecord();
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
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------
  // Data Access Methods
  // -------------------------------------------------------------

  public async getTournamentConfig(): Promise<TournamentFinancialConfig> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT config_json FROM tournament_configs WHERE id = $1', ['active_config']);
      if (res.rows.length > 0) {
        return res.rows[0].config_json as TournamentFinancialConfig;
      }
      return DEFAULT_FINANCIAL_CONFIG;
    }
    return this.local().config || DEFAULT_FINANCIAL_CONFIG;
  }

  /**
   * Saves the config, syncs entry fee / capacity into the active tournament and records the
   * change in the history, all at once. With `requireNoRegistrations`, it fails with
   * ConfigLockConflictError if a pair paid in the meantime (the lock check is re-done here).
   */
  public async saveTournamentConfig(
    config: TournamentFinancialConfig,
    tournamentId?: string,
    options: { change?: ConfigChangeRecord; requireNoRegistrations?: boolean } = {}
  ): Promise<void> {
    const { change, requireNoRegistrations } = options;
    const lockConflict = () =>
      new ConfigLockConflictError(
        'Una pareja se inscribió mientras editabas: la cuota y el reparto quedaron bloqueados. Recarga y revisa.'
      );
    const pool = this.backend();
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (requireNoRegistrations && tournamentId) {
          const res = await client.query(
            'SELECT registered_couples_count FROM tournaments WHERE id = $1 FOR UPDATE',
            [tournamentId]
          );
          if (res.rows.length > 0 && parseInt(res.rows[0].registered_couples_count || 0, 10) > 0) {
            throw lockConflict();
          }
        }
        if (change) {
          await client.query(
            `INSERT INTO config_changes (id, changed_at, admin_ip, forced, reason, registered_couples_at_change, changes_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              change.id,
              change.changed_at,
              change.admin_ip,
              change.forced,
              change.reason,
              change.registered_couples_at_change,
              JSON.stringify(change.changes)
            ]
          );
        }
        await client.query(
          `INSERT INTO tournament_configs (id, config_json, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET config_json = $2, updated_at = CURRENT_TIMESTAMP`,
          ['active_config', JSON.stringify(config)]
        );
        if (tournamentId) {
          await client.query(
            `UPDATE tournaments SET entry_fee_usd = $2, max_couples = $3, config_snapshot_json = $4
             WHERE id = $1 AND status <> 'completed'`,
            [tournamentId, config.entry_fee_per_pair, config.max_couples_limit, JSON.stringify(config)]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return;
    }
    const data = this.local();
    if (
      requireNoRegistrations &&
      tournamentId &&
      data.tournament.id === tournamentId &&
      data.tournament.registered_couples_count > 0
    ) {
      throw lockConflict();
    }
    data.config = config;
    if (tournamentId && data.tournament.id === tournamentId && data.tournament.status !== 'completed') {
      data.tournament.entry_fee_usd = config.entry_fee_per_pair;
      data.tournament.max_couples = config.max_couples_limit;
      data.tournament.config_snapshot = config;
    }
    if (change) {
      if (!data.config_changes) data.config_changes = [];
      data.config_changes.unshift({ ...change });
      if (data.config_changes.length > 200) data.config_changes.length = 200;
    }
    this.persistLocalData();
  }

  public async listConfigChanges(limit = 50): Promise<ConfigChangeRecord[]> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT * FROM config_changes ORDER BY changed_at DESC LIMIT $1', [limit]);
      return res.rows.map(mapConfigChangeRow);
    }
    return (this.local().config_changes || []).slice(0, limit).map((c) => ({ ...c }));
  }

  public async getActiveTournament(): Promise<TournamentRecord> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query(
        `SELECT id, name, status, entry_fee_usd, max_couples, registered_couples_count,
                accumulated_prize_pool, accumulated_charity_amount, accumulated_operating_margin,
                config_snapshot_json, created_at, completed_at
         FROM tournaments WHERE status IN ('active', 'in_progress', 'draft')
         ORDER BY created_at DESC LIMIT 1`
      );
      if (res.rows.length > 0) {
        return mapTournamentRow(res.rows[0]);
      }
      return defaultTournamentRecord();
    }
    return { ...this.local().tournament };
  }

  public async saveTournament(tourney: TournamentRecord): Promise<void> {
    const pool = this.backend();
    if (pool) {
      // Counters and pools are only modified atomically by applyApprovedPayment
      await pool.query(
        `INSERT INTO tournaments (
          id, name, status, entry_fee_usd, max_couples, registered_couples_count,
          accumulated_prize_pool, accumulated_charity_amount, accumulated_operating_margin,
          config_snapshot_json, created_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          name = $2, status = $3, entry_fee_usd = $4, max_couples = $5,
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
      return;
    }
    const data = this.local();
    data.tournament = {
      ...tourney,
      // keep counters owned by applyApprovedPayment
      registered_couples_count: data.tournament.id === tourney.id ? data.tournament.registered_couples_count : tourney.registered_couples_count,
      accumulated_prize_pool: data.tournament.id === tourney.id ? data.tournament.accumulated_prize_pool : tourney.accumulated_prize_pool,
      accumulated_charity_amount: data.tournament.id === tourney.id ? data.tournament.accumulated_charity_amount : tourney.accumulated_charity_amount,
      accumulated_operating_margin: data.tournament.id === tourney.id ? data.tournament.accumulated_operating_margin : tourney.accumulated_operating_margin
    };
    this.persistLocalData();
  }

  public async getReferralByCode(codeRaw: string): Promise<ReferralRecord | null> {
    const code = (codeRaw || '').trim().toUpperCase();
    if (!code) return null;

    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT * FROM referrals WHERE UPPER(referral_code) = $1', [code]);
      return res.rows.length > 0 ? mapReferralRow(res.rows[0]) : null;
    }
    const found = this.local().referrals.find((r) => r.referral_code.toUpperCase() === code);
    return found ? { ...found } : null;
  }

  public async getReferralById(id: string): Promise<ReferralRecord | null> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT * FROM referrals WHERE id = $1', [id]);
      return res.rows.length > 0 ? mapReferralRow(res.rows[0]) : null;
    }
    const found = this.local().referrals.find((r) => r.id === id);
    return found ? { ...found } : null;
  }

  public async createReferral(ref: ReferralRecord): Promise<void> {
    const pool = this.backend();
    if (pool) {
      await pool.query(
        `INSERT INTO referrals (
          id, referral_code, collaborator_name, collaborator_payphone_number,
          total_couples_referred, accumulated_earnings_usd, settled_earnings_usd,
          pending_earnings_usd, created_at
        ) VALUES ($1, $2, $3, $4, 0, 0, 0, 0, $5)`,
        [ref.id, ref.referral_code.toUpperCase(), ref.collaborator_name, ref.collaborator_payphone_number, ref.created_at]
      );
      return;
    }
    this.local().referrals.push({ ...ref });
    this.persistLocalData();
  }

  /**
   * Atomically moves `amount` from pending to settled. Returns null if the balance is insufficient.
   */
  public async settleReferral(id: string, amount: number): Promise<ReferralRecord | null> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query(
        `UPDATE referrals
           SET settled_earnings_usd = settled_earnings_usd + $2,
               pending_earnings_usd = pending_earnings_usd - $2
         WHERE id = $1 AND pending_earnings_usd >= $2
         RETURNING *`,
        [id, amount]
      );
      return res.rows.length > 0 ? mapReferralRow(res.rows[0]) : null;
    }
    const ref = this.local().referrals.find((r) => r.id === id);
    if (!ref || ref.pending_earnings_usd + 1e-9 < amount) return null;
    ref.settled_earnings_usd = round2(ref.settled_earnings_usd + amount);
    ref.pending_earnings_usd = round2(ref.pending_earnings_usd - amount);
    this.persistLocalData();
    return { ...ref };
  }

  public async listReferrals(): Promise<ReferralRecord[]> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT * FROM referrals ORDER BY accumulated_earnings_usd DESC');
      return res.rows.map(mapReferralRow);
    }
    return this.local().referrals.map((r) => ({ ...r }));
  }

  /**
   * Applies an approved payment atomically:
   *  - the pending registration must exist and be PENDING (locked FOR UPDATE)
   *  - payments_audit insert is idempotent on payphone_transaction_id
   *  - the tournament slot is taken only if registered_couples_count < max_couples
   *  - referral counters are incremented in SQL (no read-modify-write)
   */
  public async applyApprovedPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult> {
    const pool = this.backend();
    const s = input.splits;
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const dup = await client.query('SELECT * FROM payments_audit WHERE payphone_transaction_id = $1', [
          input.payphone_transaction_id
        ]);
        if (dup.rows.length > 0) {
          await client.query('ROLLBACK');
          return { status: 'duplicate', audit: mapAuditRow(dup.rows[0]) };
        }

        const pendingRes = await client.query(
          'SELECT * FROM pending_registrations WHERE client_transaction_id = $1 FOR UPDATE',
          [input.client_transaction_id]
        );
        const pending = pendingRes.rows[0] ? mapPendingRow(pendingRes.rows[0]) : null;
        if (!pending || pending.status !== 'PENDING') {
          await client.query('ROLLBACK');
          return { status: 'not_pending', message: 'La inscripción pendiente no existe o ya fue procesada.' };
        }

        const tRes = await client.query(
          `UPDATE tournaments SET
             registered_couples_count = registered_couples_count + 1,
             accumulated_prize_pool = accumulated_prize_pool + $2,
             accumulated_charity_amount = accumulated_charity_amount + $3,
             accumulated_operating_margin = accumulated_operating_margin + $4,
             status = CASE WHEN registered_couples_count + 1 >= max_couples THEN 'in_progress' ELSE status END
           WHERE id = $1 AND status = 'active' AND registered_couples_count < max_couples
           RETURNING *`,
          [input.tournament_id, s.allocated_to_prize_pool, s.allocated_to_charity, s.allocated_to_operating_margin]
        );
        if (tRes.rows.length === 0) {
          await client.query('ROLLBACK');
          await pool.query(
            "UPDATE pending_registrations SET status = 'REFUND_REQUIRED' WHERE client_transaction_id = $1 AND status = 'PENDING'",
            [input.client_transaction_id]
          );
          return { status: 'tournament_full', message: 'El torneo ya no tiene cupos o no está abierto a inscripciones.' };
        }

        const audit: PaymentAuditRecord = {
          id: `audit-${crypto.randomUUID()}`,
          payphone_transaction_id: input.payphone_transaction_id,
          tournament_id: input.tournament_id,
          referral_id: input.referral ? input.referral.id : null,
          referral_code: input.referral ? input.referral.referral_code : null,
          pair_driver_name: pending.driver_name,
          pair_navigator_name: pending.navigator_name,
          gross_amount: s.gross_collected,
          payphone_fee: s.payphone_retention,
          prize_pool_share: s.allocated_to_prize_pool,
          charity_share: s.allocated_to_charity,
          developer_share: s.breakdown_operating_margin.developer_net,
          collaborator_share: s.breakdown_operating_margin.collaborator_referral_payout,
          status: 'APPROVED',
          raw_payload_json: input.raw_payload_json,
          pass_token: generatePassToken(),
          client_transaction_id: input.client_transaction_id,
          created_at: new Date().toISOString()
        };

        const ins = await client.query(
          `INSERT INTO payments_audit (
            id, payphone_transaction_id, tournament_id, referral_id, referral_code,
            pair_driver_name, pair_navigator_name, gross_amount, payphone_fee,
            prize_pool_share, charity_share, developer_share, collaborator_share,
            status, raw_payload_json, pass_token, client_transaction_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
          ON CONFLICT (payphone_transaction_id) DO NOTHING
          RETURNING id`,
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
            audit.pass_token,
            audit.client_transaction_id,
            audit.created_at
          ]
        );
        if (ins.rows.length === 0) {
          // Concurrent request inserted the same transaction first
          await client.query('ROLLBACK');
          const existing = await pool.query('SELECT * FROM payments_audit WHERE payphone_transaction_id = $1', [
            input.payphone_transaction_id
          ]);
          return { status: 'duplicate', audit: mapAuditRow(existing.rows[0]) };
        }

        if (input.referral && audit.collaborator_share > 0) {
          await client.query(
            `UPDATE referrals SET
               total_couples_referred = total_couples_referred + 1,
               accumulated_earnings_usd = accumulated_earnings_usd + $2,
               pending_earnings_usd = pending_earnings_usd + $2
             WHERE id = $1`,
            [input.referral.id, audit.collaborator_share]
          );
        }

        await client.query(
          "UPDATE pending_registrations SET status = 'COMPLETED', tournament_id = $2 WHERE client_transaction_id = $1",
          [input.client_transaction_id, input.tournament_id]
        );

        await client.query('COMMIT');
        return { status: 'applied', audit, tournament: mapTournamentRow(tRes.rows[0]) };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // Local dev storage: fully synchronous below this point, so it is atomic in Node's event loop
    const data = this.local();
    const dup = data.payments.find((p) => p.payphone_transaction_id === input.payphone_transaction_id);
    if (dup) return { status: 'duplicate', audit: { ...dup } };

    const pending = data.pending_registrations?.find((p) => p.client_transaction_id === input.client_transaction_id);
    if (!pending || pending.status !== 'PENDING') {
      return { status: 'not_pending', message: 'La inscripción pendiente no existe o ya fue procesada.' };
    }

    const t = data.tournament;
    if (t.id !== input.tournament_id || t.status !== 'active' || t.registered_couples_count >= t.max_couples) {
      pending.status = 'REFUND_REQUIRED';
      this.persistLocalData();
      return { status: 'tournament_full', message: 'El torneo ya no tiene cupos o no está abierto a inscripciones.' };
    }

    t.registered_couples_count++;
    t.accumulated_prize_pool = round2(t.accumulated_prize_pool + s.allocated_to_prize_pool);
    t.accumulated_charity_amount = round2(t.accumulated_charity_amount + s.allocated_to_charity);
    t.accumulated_operating_margin = round2(t.accumulated_operating_margin + s.allocated_to_operating_margin);
    if (t.registered_couples_count >= t.max_couples) t.status = 'in_progress';

    const audit: PaymentAuditRecord = {
      id: `audit-${crypto.randomUUID()}`,
      payphone_transaction_id: input.payphone_transaction_id,
      tournament_id: input.tournament_id,
      referral_id: input.referral ? input.referral.id : null,
      referral_code: input.referral ? input.referral.referral_code : null,
      pair_driver_name: pending.driver_name,
      pair_navigator_name: pending.navigator_name,
      gross_amount: s.gross_collected,
      payphone_fee: s.payphone_retention,
      prize_pool_share: s.allocated_to_prize_pool,
      charity_share: s.allocated_to_charity,
      developer_share: s.breakdown_operating_margin.developer_net,
      collaborator_share: s.breakdown_operating_margin.collaborator_referral_payout,
      status: 'APPROVED',
      raw_payload_json: input.raw_payload_json,
      pass_token: generatePassToken(),
      client_transaction_id: input.client_transaction_id,
      created_at: new Date().toISOString()
    };
    data.payments.unshift(audit);

    if (input.referral && audit.collaborator_share > 0) {
      const ref = data.referrals.find((r) => r.id === input.referral!.id);
      if (ref) {
        ref.total_couples_referred++;
        ref.accumulated_earnings_usd = round2(ref.accumulated_earnings_usd + audit.collaborator_share);
        ref.pending_earnings_usd = round2(ref.pending_earnings_usd + audit.collaborator_share);
      }
    }

    pending.status = 'COMPLETED';
    pending.tournament_id = input.tournament_id;
    this.persistLocalData();
    return { status: 'applied', audit: { ...audit }, tournament: { ...t } };
  }

  public async listPaymentAudits(): Promise<PaymentAuditRecord[]> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT * FROM payments_audit ORDER BY created_at DESC LIMIT 100');
      return res.rows.map(mapAuditRow);
    }
    return this.local().payments.slice(0, 100).map((p) => ({ ...p }));
  }

  /**
   * Totals over EVERY approved payment of a tournament (the ledger listing is capped at 100 rows,
   * so totals must not be summed from it). Collaborator shares of rows without a referral
   * (legacy data) count as platform income, as nobody earned them.
   */
  public async getPaymentTotals(tournamentId: string): Promise<{
    count: number;
    gross: number;
    payphone: number;
    prize: number;
    charity: number;
    developer: number;
    collaborators: number;
  }> {
    const pool = this.backend();
    if (pool) {
      const res = await pool.query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(gross_amount), 0) AS gross,
                COALESCE(SUM(payphone_fee), 0) AS payphone,
                COALESCE(SUM(prize_pool_share), 0) AS prize,
                COALESCE(SUM(charity_share), 0) AS charity,
                COALESCE(SUM(developer_share + CASE WHEN referral_id IS NULL THEN collaborator_share ELSE 0 END), 0) AS developer,
                COALESCE(SUM(CASE WHEN referral_id IS NOT NULL THEN collaborator_share ELSE 0 END), 0) AS collaborators
         FROM payments_audit WHERE status = 'APPROVED' AND tournament_id = $1`,
        [tournamentId]
      );
      const r = res.rows[0];
      return {
        count: parseInt(r.count, 10),
        gross: round2(parseFloat(r.gross)),
        payphone: round2(parseFloat(r.payphone)),
        prize: round2(parseFloat(r.prize)),
        charity: round2(parseFloat(r.charity)),
        developer: round2(parseFloat(r.developer)),
        collaborators: round2(parseFloat(r.collaborators))
      };
    }
    const totals = { count: 0, gross: 0, payphone: 0, prize: 0, charity: 0, developer: 0, collaborators: 0 };
    for (const p of this.local().payments) {
      if (p.status !== 'APPROVED' || p.tournament_id !== tournamentId) continue;
      totals.count++;
      totals.gross += p.gross_amount;
      totals.payphone += p.payphone_fee;
      totals.prize += p.prize_pool_share;
      totals.charity += p.charity_share;
      totals.developer += p.developer_share + (p.referral_id ? 0 : p.collaborator_share);
      totals.collaborators += p.referral_id ? p.collaborator_share : 0;
    }
    return {
      count: totals.count,
      gross: round2(totals.gross),
      payphone: round2(totals.payphone),
      prize: round2(totals.prize),
      charity: round2(totals.charity),
      developer: round2(totals.developer),
      collaborators: round2(totals.collaborators)
    };
  }

  public async getPaymentAuditByTransactionId(txId: string): Promise<PaymentAuditRecord | null> {
    if (!txId) return null;
    const cleanId = String(txId).trim();
    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT * FROM payments_audit WHERE payphone_transaction_id = $1 LIMIT 1', [cleanId]);
      return res.rows.length > 0 ? mapAuditRow(res.rows[0]) : null;
    }
    const found = this.local().payments.find((p) => p.payphone_transaction_id === cleanId);
    return found ? { ...found } : null;
  }

  public async savePendingRegistration(record: PendingRegistrationRecord): Promise<void> {
    const pool = this.backend();
    if (pool) {
      // Insert only: an existing registration (possibly COMPLETED) must never be overwritten
      await pool.query(
        `INSERT INTO pending_registrations (
          client_transaction_id, driver_name, navigator_name, referral_code, phone, amount_usd, status, tournament_id, created_at, room_code,
          config_snapshot_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.client_transaction_id,
          record.driver_name,
          record.navigator_name,
          record.referral_code || null,
          record.phone || null,
          record.amount_usd,
          record.status,
          record.tournament_id || null,
          record.created_at,
          record.room_code || null,
          record.config_snapshot ? JSON.stringify(record.config_snapshot) : null
        ]
      );
      return;
    }
    const data = this.local();
    if (!data.pending_registrations) data.pending_registrations = [];
    if (data.pending_registrations.some((p) => p.client_transaction_id === record.client_transaction_id)) {
      throw new Error(`Inscripción ${record.client_transaction_id} ya existe.`);
    }
    data.pending_registrations.push({ ...record });
    this.persistLocalData();
  }

  public async getPendingRegistration(clientTxId: string): Promise<PendingRegistrationRecord | null> {
    if (!clientTxId) return null;
    const cleanId = String(clientTxId).trim();
    const pool = this.backend();
    if (pool) {
      const res = await pool.query('SELECT * FROM pending_registrations WHERE client_transaction_id = $1 LIMIT 1', [
        cleanId
      ]);
      return res.rows.length > 0 ? mapPendingRow(res.rows[0]) : null;
    }
    const found = this.local().pending_registrations?.find((p) => p.client_transaction_id === cleanId);
    return found ? { ...found } : null;
  }

  public async markPendingRegistrationStatus(
    clientTxId: string,
    status: PendingRegistrationRecord['status']
  ): Promise<void> {
    if (!clientTxId) return;
    const cleanId = String(clientTxId).trim();
    const pool = this.backend();
    if (pool) {
      await pool.query('UPDATE pending_registrations SET status = $2 WHERE client_transaction_id = $1', [cleanId, status]);
      return;
    }
    const rec = this.local().pending_registrations?.find((p) => p.client_transaction_id === cleanId);
    if (rec) {
      rec.status = status;
      this.persistLocalData();
    }
  }

  public async markPendingRegistrationComplete(clientTxId: string): Promise<void> {
    await this.markPendingRegistrationStatus(clientTxId, 'COMPLETED');
  }

  /**
   * Validates a tournament pass token. Only random tokens issued on payment approval are
   * accepted (never Payphone transaction ids), and only for the given tournament.
   */
  public async verifyTournamentPass(
    passCode: string,
    tournamentId?: string
  ): Promise<{
    valid: boolean;
    driver_name?: string;
    navigator_name?: string;
    tournament_id?: string;
    status?: string;
    message?: string;
  }> {
    const clean = String(passCode || '').trim().toUpperCase();
    if (!/^PS(-[0-9A-F]{4}){8}$/.test(clean)) {
      return { valid: false, message: 'Código de pase no válido.' };
    }

    let found: PaymentAuditRecord | null = null;
    const pool = this.backend();
    if (pool) {
      const res = await pool.query(
        "SELECT * FROM payments_audit WHERE pass_token = $1 AND status = 'APPROVED' LIMIT 1",
        [clean]
      );
      found = res.rows.length > 0 ? mapAuditRow(res.rows[0]) : null;
    } else {
      found = this.local().payments.find((p) => p.pass_token === clean && p.status === 'APPROVED') || null;
    }

    if (!found || (tournamentId && found.tournament_id !== tournamentId)) {
      return { valid: false, message: 'Código de pase no encontrado para el torneo activo.' };
    }

    return {
      valid: true,
      driver_name: found.pair_driver_name,
      navigator_name: found.pair_navigator_name,
      tournament_id: found.tournament_id,
      status: 'ACTIVE'
    };
  }
}

export const dbProvider = new DatabaseProvider();
