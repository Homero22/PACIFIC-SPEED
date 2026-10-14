import { escapeHtml } from '../shared/escapeHtml.js';
import {
  applyFinancialConfigUpdate,
  calculateTransactionSplits,
  configToUpdateValues,
  diffFinancialConfig,
  type ConfigFieldChange,
  type FinancialConfigUpdate,
  type TournamentFinancialConfig
} from '../shared/financialConfig.js';
import type {
  AdminDashboardData,
  ConfigChangeRecord,
  PaymentAuditRecord,
  ReferralRecord,
  SecurityAuditLog
} from '../shared/types.js';

const usd = (v: unknown) =>
  `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** 0.6 -> "60%", 0.0575 -> "5.75%" */
const pct = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

// Prevents CSV/formula injection when the export is opened in Excel/Sheets
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Shows a config value in the unit the admin reads it in. */
function formatConfigValue(field: keyof FinancialConfigUpdate, value: number): string {
  if (field === 'entry_fee_per_pair') return usd(value);
  if (field === 'max_couples_limit') return `${value} parejas`;
  return pct(value);
}

const LOCKED_INPUT_IDS = ['cfg-entry-fee', 'cfg-prize-pool', 'cfg-charity', 'cfg-payphone-fee', 'cfg-dev-share'];
const MIN_FORCE_REASON = 10;

interface ConfirmOptions {
  title: string;
  bodyHtml: string;
  confirmLabel: string;
  danger?: boolean;
  /** The admin must type this text to enable the confirm button. */
  requireText?: string;
}

class PacificSpeedAdminApp {
  private token: string | null = null;
  private data: AdminDashboardData | null = null;
  private currentPayments: PaymentAuditRecord[] = [];
  private toastTimer: number | null = null;

  constructor() {
    this.token = sessionStorage.getItem('ps_admin_token') || localStorage.getItem('ps_admin_token');
    this.bindEvents();
    if (this.token) {
      void this.loadDashboard();
    } else {
      this.showLoginView();
    }
  }

  // -------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------

  private showLoginView(): void {
    el('view-login')?.classList.remove('hidden');
    el('view-dashboard')?.classList.add('hidden');
  }

  private showDashboardView(): void {
    el('view-login')?.classList.add('hidden');
    el('view-dashboard')?.classList.remove('hidden');
  }

  private toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
    const box = el('toast');
    if (!box) return;
    box.textContent = message;
    box.className = `toast is-${kind}`;
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => box.classList.add('hidden'), kind === 'error' ? 7000 : 4000);
  }

  /** Native <dialog> confirmation; resolves true only when the admin confirms. */
  private confirmAction(opts: ConfirmOptions): Promise<boolean> {
    const dialog = el<HTMLDialogElement>('confirm-dialog');
    const okBtn = el<HTMLButtonElement>('confirm-ok');
    const typedWrap = el('confirm-typed-wrap');
    const typedInput = el<HTMLInputElement>('confirm-typed');
    if (!dialog || !okBtn || !typedWrap || !typedInput) return Promise.resolve(false);

    el('confirm-title')!.textContent = opts.title;
    el('confirm-body')!.innerHTML = opts.bodyHtml;
    okBtn.textContent = opts.confirmLabel;
    okBtn.className = `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`;

    typedInput.value = '';
    typedWrap.classList.toggle('hidden', !opts.requireText);
    okBtn.disabled = Boolean(opts.requireText);
    if (opts.requireText) {
      el('confirm-typed-label')!.textContent = `Escribe ${opts.requireText} para confirmar`;
      typedInput.oninput = () => {
        okBtn.disabled = typedInput.value.trim().toUpperCase() !== opts.requireText;
      };
    }

    const form = dialog.querySelector('form')!;
    return new Promise((resolve) => {
      // Resolve on the form submit itself: the dialog 'close' event is not reliably
      // dispatched while the tab is in the background, so it is only a fallback (Esc).
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        form.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('close', onClose);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onSubmit = (e: SubmitEvent) => {
        const submitter = e.submitter as HTMLButtonElement | null;
        finish(submitter?.value === 'ok' && !okBtn.disabled);
      };
      const onClose = () => finish(false);
      form.addEventListener('submit', onSubmit);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      (opts.requireText ? typedInput : okBtn).focus();
    });
  }

  private async api<T = any>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401) {
      this.handleLogout('Tu sesión expiró. Ingresa la clave de nuevo.');
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  private bindEvents(): void {
    el('form-login')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleLogin();
    });
    el('btn-logout')?.addEventListener('click', () => this.handleLogout());
    el('btn-refresh-data')?.addEventListener('click', () => void this.loadDashboard());

    document.querySelectorAll<HTMLAnchorElement>('.nav-link[data-tab]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = link.dataset.tab;
        if (!target) return;
        document.querySelectorAll('.nav-link[data-tab]').forEach((l) => l.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
        link.classList.add('active');
        el(target)?.classList.remove('hidden');
      });
    });

    el('search-payments')?.addEventListener('input', (e) => {
      this.renderPaymentsTable((e.target as HTMLInputElement).value.toLowerCase().trim());
    });
    el('btn-export-csv')?.addEventListener('click', () => this.exportPaymentsCSV());

    el('form-create-referral')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleCreateReferral();
    });

    // Financial config: every edit re-runs the simulator and validation
    const form = el<HTMLFormElement>('form-config');
    form?.addEventListener('input', () => this.updateConfigPreview());
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleReviewConfig();
    });
    el('cfg-force')?.addEventListener('change', () => {
      this.applyLockState();
      this.updateConfigPreview();
    });
    el('btn-config-reset')?.addEventListener('click', () => {
      if (this.data) this.populateConfigForm(this.data.active_config, true);
    });

    el('btn-close-tournament-action')?.addEventListener('click', () => void this.handleCloseTournament());
    el('btn-clear-security-logs')?.addEventListener('click', () => void this.handleClearSecurityLogs());
  }

  private async handleLogin(): Promise<void> {
    const input = el<HTMLInputElement>('login-password');
    const errorBox = el('login-error-box');
    const submitBtn = el<HTMLButtonElement>('btn-login-submit');
    if (!input) return;

    if (errorBox) errorBox.style.display = 'none';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verificando…';
    }

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value.trim() })
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        if (errorBox) {
          errorBox.textContent = data.error || 'Clave de administración inválida.';
          errorBox.style.display = 'block';
        }
        return;
      }
      this.token = data.token;
      sessionStorage.setItem('ps_admin_token', this.token!);
      input.value = '';
      await this.loadDashboard();
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = `Error de conexión: ${(err as Error).message}`;
        errorBox.style.display = 'block';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Entrar';
      }
    }
  }

  private handleLogout(message?: string): void {
    this.token = null;
    sessionStorage.removeItem('ps_admin_token');
    localStorage.removeItem('ps_admin_token');
    this.showLoginView();
    const errorBox = el('login-error-box');
    if (message && errorBox) {
      errorBox.textContent = message;
      errorBox.style.display = 'block';
    }
  }

  private async loadDashboard(): Promise<void> {
    if (!this.token) {
      this.showLoginView();
      return;
    }
    try {
      const { ok, status, data } = await this.api<AdminDashboardData>('/api/admin/dashboard');
      if (status === 401) return;
      if (!ok) throw new Error((data as any)?.error || `Error ${status}`);
      this.data = data;
      this.currentPayments = data.payments_audit || [];
      this.showDashboardView();
      this.renderDashboard(data);
      const stamp = el('last-refresh');
      if (stamp) stamp.textContent = `Actualizado ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      this.toast(`No se pudieron cargar los datos: ${(err as Error).message}`, 'error');
    }
  }

  // -------------------------------------------------------------
  // Overview, tournament, payments, referrals, security
  // -------------------------------------------------------------

  private renderDashboard(data: AdminDashboardData): void {
    const fin = data.financial_summary;
    const t = data.tournament;
    const cfg = data.active_config;

    this.setText('kpi-gross', usd(fin.gross_collected_total));
    this.setText('kpi-prize-pool', usd(fin.prize_pool_total));
    this.setText('kpi-charity', usd(fin.charity_total));
    this.setText('kpi-couples', `${t.registered_couples_count} / ${t.max_couples}`);

    const badge = el('overview-status-badge');
    if (badge) {
      const done = t.status === 'completed';
      badge.textContent = done ? 'Torneo cerrado' : t.status === 'active' ? 'Inscripciones abiertas' : 'Torneo en curso';
      badge.className = `status ${done ? '' : 'status-ok'}`;
    }

    const gross = fin.gross_collected_total;
    const share = (v: number) => (gross > 0 ? pct(v / gross) : '—');
    const rows: Array<[string, number]> = [
      ['Pozo de premios', fin.prize_pool_total],
      ['Refugio animal', fin.charity_total],
      ['Comisión Payphone', fin.payphone_fees_total],
      ['Plataforma', fin.developer_net_total],
      ['Afiliados', fin.collaborator_payouts_total]
    ];
    const breakdown = el('overview-breakdown-body');
    if (breakdown) {
      breakdown.innerHTML = rows
        .map(([label, v]) => `<tr><td>${label}</td><td class="num">${usd(v)}</td><td class="num">${share(v)}</td></tr>`)
        .join('');
    }

    const podium = cfg.prize_podium_breakdown;
    const pool = fin.prize_pool_total;
    this.setText('overview-podium-1', usd(pool * podium.first_place_percentage));
    this.setText('overview-podium-2', usd(pool * podium.second_place_percentage));
    this.setText('overview-podium-3', usd(pool * podium.third_place_percentage));
    this.setText('overview-podium-1-pct', pct(podium.first_place_percentage));
    this.setText('overview-podium-2-pct', pct(podium.second_place_percentage));
    this.setText('overview-podium-3-pct', pct(podium.third_place_percentage));

    this.setText('tourney-panel-name', t.name);
    this.setText('tourney-panel-couples', `${t.registered_couples_count} de ${t.max_couples} parejas`);
    this.setText('tourney-panel-fee', usd(t.entry_fee_usd));
    const closeBtn = el<HTMLButtonElement>('btn-close-tournament-action');
    if (closeBtn) closeBtn.disabled = t.status === 'completed';

    this.renderPaymentsTable((el<HTMLInputElement>('search-payments')?.value || '').toLowerCase().trim());
    this.renderReferralsTable(data.referrals || []);
    this.populateConfigForm(cfg);
    this.renderConfigHistory(data.config_history || []);
    this.renderSecurityTable(data.security_logs || []);
  }

  private renderPaymentsTable(filterTerm = ''): void {
    const tbody = el('table-payments-body');
    if (!tbody) return;

    const items = filterTerm
      ? this.currentPayments.filter((p) =>
          [p.payphone_transaction_id, p.pair_driver_name, p.pair_navigator_name, p.referral_code || '']
            .some((v) => v.toLowerCase().includes(filterTerm))
        )
      : this.currentPayments;

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty">${
        filterTerm ? 'Ningún pago coincide con la búsqueda.' : 'Todavía no hay pagos.'
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = items
      .map((p) => {
        const statusClass = p.status === 'APPROVED' ? 'status-ok' : 'status-error';
        const statusText = p.status === 'APPROVED' ? 'Aprobado' : p.status;
        return `
          <tr>
            <td>${escapeHtml(new Date(p.created_at).toLocaleString())}
              <span class="cell-sub mono" title="ID Payphone">${escapeHtml(p.payphone_transaction_id)}</span></td>
            <td>${escapeHtml(p.pair_driver_name)} / ${escapeHtml(p.pair_navigator_name)}
              ${p.pass_token ? `<span class="cell-sub mono" title="Pase de torneo">${escapeHtml(p.pass_token)}</span>` : ''}</td>
            <td class="num">${usd(p.gross_amount)}</td>
            <td class="num">${usd(p.payphone_fee)}</td>
            <td class="num">${usd(p.prize_pool_share)}</td>
            <td class="num">${usd(p.charity_share)}</td>
            <td class="num">${usd(p.developer_share + (p.referral_id ? 0 : p.collaborator_share))}</td>
            <td>${p.referral_id ? `${escapeHtml(p.referral_code || '')} <span class="cell-sub">${usd(p.collaborator_share)}</span>` : '<span class="muted">—</span>'}</td>
            <td><span class="status ${statusClass}">${escapeHtml(statusText)}</span></td>
          </tr>`;
      })
      .join('');
  }

  private renderReferralsTable(referrals: ReferralRecord[]): void {
    const tbody = el('table-referrals-body');
    if (!tbody) return;

    if (referrals.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Todavía no hay afiliados.</td></tr>';
      return;
    }

    tbody.innerHTML = referrals
      .map((r) => {
        const hasPending = r.pending_earnings_usd > 0;
        return `
          <tr>
            <td class="mono">${escapeHtml(r.referral_code)}</td>
            <td>${escapeHtml(r.collaborator_name)}</td>
            <td class="mono">${escapeHtml(r.collaborator_payphone_number || '—')}</td>
            <td class="num">${Number(r.total_couples_referred) || 0}</td>
            <td class="num">${usd(r.accumulated_earnings_usd)}</td>
            <td class="num">${usd(r.pending_earnings_usd)}</td>
            <td>${
              hasPending
                ? `<button class="btn btn-ghost btn-settle-payout" data-id="${escapeHtml(r.id)}">Marcar pagado…</button>`
                : '<span class="muted small">Al día</span>'
            }</td>
          </tr>`;
      })
      .join('');

    tbody.querySelectorAll<HTMLButtonElement>('.btn-settle-payout').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ref = referrals.find((r) => r.id === btn.dataset.id);
        if (ref) void this.handleSettleReferral(ref);
      });
    });
  }

  private renderSecurityTable(logs: SecurityAuditLog[]): void {
    const tbody = el('table-security-body');
    if (!tbody) return;
    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin eventos registrados.</td></tr>';
      return;
    }
    const levelClass: Record<string, string> = { critical: 'status-error', high: 'status-warn' };
    tbody.innerHTML = logs
      .map(
        (log) => `
          <tr>
            <td class="small">${escapeHtml(new Date(log.timestamp).toLocaleString())}</td>
            <td><span class="status ${levelClass[log.severity] || ''}">${escapeHtml(log.severity)}</span></td>
            <td class="mono">${escapeHtml(log.event_type)}</td>
            <td class="mono">${escapeHtml(log.ip_address)}</td>
            <td class="small muted">${escapeHtml(log.details)}</td>
          </tr>`
      )
      .join('');
  }

  // -------------------------------------------------------------
  // Financial config: simulator, validation, lock, review, history
  // -------------------------------------------------------------

  private readNumber(id: string): number {
    const input = el<HTMLInputElement>(id);
    return input && input.value.trim() !== '' ? Number(input.value) : NaN;
  }

  /** Form values converted to the API units (fractions, not percentages). */
  private readConfigForm(): FinancialConfigUpdate {
    const dev = this.readNumber('cfg-dev-share') / 100;
    return {
      entry_fee_per_pair: this.readNumber('cfg-entry-fee'),
      max_couples_limit: this.readNumber('cfg-max-couples'),
      prize_pool_percentage: this.readNumber('cfg-prize-pool') / 100,
      charity_percentage: this.readNumber('cfg-charity') / 100,
      payphone_percentage_fee: this.readNumber('cfg-payphone-fee') / 100,
      developer_share_of_margin: dev,
      collaborator_share_of_margin: Number((1 - dev).toFixed(6))
    };
  }

  /** Same math as the server: builds the candidate config or explains why it is invalid. */
  private buildCandidate(): { config?: TournamentFinancialConfig; error?: string } {
    if (!this.data) return {};
    const dto = this.readConfigForm();
    const missing = Object.entries(dto).find(([, v]) => !Number.isFinite(v));
    if (missing) return { error: 'Completa todos los campos con números válidos.' };
    try {
      return { config: applyFinancialConfigUpdate(this.data.active_config, dto) };
    } catch (err) {
      return { error: (err as Error).message.replace(/fracción entre 0 y 1/g, 'porcentaje entre 0% y 100%') };
    }
  }

  private populateConfigForm(cfg: TournamentFinancialConfig, force = false): void {
    // Do not overwrite unsaved edits on a background refresh
    if (!force && this.hasUnsavedConfigChanges()) {
      this.applyLockState();
      this.updateConfigPreview();
      return;
    }
    const v = configToUpdateValues(cfg);
    const set = (id: string, value: number) => {
      const input = el<HTMLInputElement>(id);
      if (input) input.value = String(Number(value.toFixed(4)));
    };
    set('cfg-entry-fee', v.entry_fee_per_pair);
    set('cfg-max-couples', v.max_couples_limit);
    set('cfg-prize-pool', v.prize_pool_percentage * 100);
    set('cfg-charity', v.charity_percentage * 100);
    set('cfg-payphone-fee', v.payphone_percentage_fee * 100);
    set('cfg-dev-share', v.developer_share_of_margin * 100);

    const forceBox = el<HTMLInputElement>('cfg-force');
    if (forceBox) forceBox.checked = false;
    const reason = el<HTMLTextAreaElement>('cfg-reason');
    if (reason) reason.value = '';

    this.applyLockState();
    this.updateConfigPreview();
  }

  private hasUnsavedConfigChanges(): boolean {
    if (!this.data) return false;
    const { config } = this.buildCandidate();
    if (!config) return el<HTMLInputElement>('cfg-entry-fee')?.value !== '';
    return diffFinancialConfig(this.data.active_config, config).length > 0;
  }

  private applyLockState(): void {
    const lock = this.data?.config_lock;
    const locked = Boolean(lock?.locked);
    const forced = Boolean(el<HTMLInputElement>('cfg-force')?.checked);

    const banner = el('config-lock-banner');
    if (banner) {
      banner.classList.toggle('hidden', !locked);
      if (locked && lock) {
        banner.innerHTML = `<strong>Cuota y reparto bloqueados.</strong> Ya hay ${lock.registered_couples} pareja(s) inscrita(s) con estos valores. Puedes ampliar el cupo; para cambiar la cuota o los porcentajes, marca "Forzar cambio" e indica el motivo.`;
      }
    }
    el('force-box')?.classList.toggle('hidden', !locked);
    el('force-reason-wrap')?.classList.toggle('hidden', !(locked && forced));
    for (const id of LOCKED_INPUT_IDS) {
      const input = el<HTMLInputElement>(id);
      if (input) input.disabled = locked && !forced;
    }
  }

  private updateConfigPreview(): void {
    if (!this.data) return;
    const active = this.data.active_config;
    const { config, error } = this.buildCandidate();
    const issues: Array<{ kind: 'error' | 'warn' | 'ok'; text: string }> = [];

    // Field hints derived from the inputs
    const base = this.readNumber('cfg-payphone-fee') / 100;
    const iva = active.pricing_structure.payphone_gateway.tax_on_fee_percentage;
    this.setText(
      'cfg-payphone-effective',
      Number.isFinite(base) ? `Con ${pct(iva)} de IVA sobre la comisión: ${pct(base * (1 + iva))} efectivo.` : ''
    );
    const dev = this.readNumber('cfg-dev-share') / 100;
    this.setText('cfg-collab-share', Number.isFinite(dev) ? `Afiliado que trajo a la pareja: ${pct(Math.max(0, 1 - dev))}. Sin afiliado, todo el margen queda en la plataforma.` : '');

    const target = config || active;
    const fee = config ? config.entry_fee_per_pair : active.entry_fee_per_pair;
    const withRef = calculateTransactionSplits(fee, target, true);
    const noRef = calculateTransactionSplits(fee, target, false);
    const ps = target.pricing_structure;
    const rows: Array<{ label: string; frac: number; a: number; b: number }> = [
      { label: 'Pozo de premios', frac: ps.revenue_allocation_percentages.prize_pool.percentage_of_gross, a: withRef.allocated_to_prize_pool, b: noRef.allocated_to_prize_pool },
      { label: 'Refugio animal', frac: ps.revenue_allocation_percentages.animal_charity.percentage_of_gross, a: withRef.allocated_to_charity, b: noRef.allocated_to_charity },
      { label: 'Comisión Payphone', frac: ps.payphone_gateway.effective_fee_percentage_calculated, a: withRef.payphone_retention, b: noRef.payphone_retention },
      { label: 'Plataforma', frac: ps.margin_sub_distribution.platform_developer_share.effective_percentage_of_gross, a: withRef.breakdown_operating_margin.developer_net, b: noRef.breakdown_operating_margin.developer_net },
      { label: 'Afiliado', frac: ps.margin_sub_distribution.collaborator_pool_share.effective_percentage_of_gross, a: withRef.breakdown_operating_margin.collaborator_referral_payout, b: 0 }
    ];

    const body = el('sim-body');
    if (body) {
      body.innerHTML = rows
        .map(
          (r, i) => `<tr><td><span class="swatch seg-${i}"></span>${r.label}</td><td class="num">${pct(r.frac)}</td><td class="num">${usd(r.a)}</td><td class="num">${usd(r.b)}</td></tr>`
        )
        .join('');
    }
    const sumA = rows.reduce((s, r) => s + r.a, 0);
    const sumB = rows.reduce((s, r) => s + r.b, 0);
    const balanced = Math.abs(sumA - fee) < 0.005 && Math.abs(sumB - fee) < 0.005;
    const foot = el('sim-foot');
    if (foot) {
      foot.innerHTML = `<tr><td>Total que paga la pareja</td><td class="num">100%</td><td class="num">${usd(sumA)}</td><td class="num">${usd(sumB)}</td></tr>`;
    }
    const bar = el('sim-bar');
    if (bar) {
      bar.innerHTML = rows
        .map((r, i) => `<span class="seg-${i}" style="width:${Math.max(0, r.frac * 100)}%" title="${r.label} ${pct(r.frac)}"></span>`)
        .join('');
    }

    if (error) {
      issues.push({ kind: 'error', text: error });
    } else if (config) {
      issues.push(
        balanced
          ? { kind: 'ok', text: `Cuadra: los repartos suman exactamente ${usd(fee)} por pareja.` }
          : { kind: 'error', text: 'El reparto no suma la cuota completa.' }
      );
      if (ps.revenue_allocation_percentages.gross_operating_margin.percentage_of_gross < 0.05) {
        issues.push({ kind: 'warn', text: `El margen operativo queda en ${pct(ps.revenue_allocation_percentages.gross_operating_margin.percentage_of_gross)}: casi no cubre infraestructura.` });
      }
    }

    const changes = config ? diffFinancialConfig(active, config) : [];
    const lock = this.data.config_lock;
    const forced = Boolean(el<HTMLInputElement>('cfg-force')?.checked);
    const reason = (el<HTMLTextAreaElement>('cfg-reason')?.value || '').trim();
    const touchesLocked = changes.some((c) => lock.locked_fields.includes(c.field));
    if (lock.locked && forced && touchesLocked && reason.length < MIN_FORCE_REASON) {
      issues.push({ kind: 'warn', text: `Escribe el motivo del cambio forzado (mínimo ${MIN_FORCE_REASON} caracteres).` });
    }

    const list = el('sim-issues');
    if (list) list.innerHTML = issues.map((i) => `<li class="is-${i.kind}">${escapeHtml(i.text)}</li>`).join('');

    // Mark changed fields and toggle the actions
    const changedFields = new Set(changes.map((c) => c.field));
    const idByField: Partial<Record<keyof FinancialConfigUpdate, string>> = {
      entry_fee_per_pair: 'cfg-entry-fee',
      max_couples_limit: 'cfg-max-couples',
      prize_pool_percentage: 'cfg-prize-pool',
      charity_percentage: 'cfg-charity',
      payphone_percentage_fee: 'cfg-payphone-fee',
      developer_share_of_margin: 'cfg-dev-share'
    };
    for (const [field, id] of Object.entries(idByField)) {
      const label = el(id!)?.closest('.field')?.querySelector('.field-label');
      label?.classList.toggle('changed', changedFields.has(field as keyof FinancialConfigUpdate));
    }

    const canSave =
      Boolean(config) && balanced && changes.length > 0 &&
      !(lock.locked && touchesLocked && (!forced || reason.length < MIN_FORCE_REASON));
    const reviewBtn = el<HTMLButtonElement>('btn-config-review');
    if (reviewBtn) reviewBtn.disabled = !canSave;
    const resetBtn = el<HTMLButtonElement>('btn-config-reset');
    if (resetBtn) resetBtn.disabled = changes.length === 0 && !error;
    this.setText('config-feedback', changes.length > 0 ? `${changes.length} cambio(s) sin guardar` : '');
    el('config-feedback')!.className = 'feedback';
  }

  private describeChanges(changes: ConfigFieldChange[]): string {
    return changes
      .map((c) => `<li>${escapeHtml(c.label)}: ${formatConfigValue(c.field, c.before)} → <strong>${formatConfigValue(c.field, c.after)}</strong></li>`)
      .join('');
  }

  private async handleReviewConfig(): Promise<void> {
    if (!this.data) return;
    const { config, error } = this.buildCandidate();
    if (!config || error) return;
    const changes = diffFinancialConfig(this.data.active_config, config);
    if (changes.length === 0) return;

    const lock = this.data.config_lock;
    const forced = Boolean(el<HTMLInputElement>('cfg-force')?.checked) && lock.locked;
    const reason = (el<HTMLTextAreaElement>('cfg-reason')?.value || '').trim();
    const feeChange = changes.find((c) => c.field === 'entry_fee_per_pair');

    const notes: string[] = [];
    if (feeChange) {
      notes.push(`El hangar y Payphone cobrarán <strong>${usd(feeChange.after)}</strong> a las nuevas parejas desde que guardes.`);
    }
    if (forced) {
      notes.push(`<strong>Cambio forzado:</strong> ${lock.registered_couples} pareja(s) ya pagaron con los valores anteriores; sus pagos no cambian. Quedará en el historial con tu motivo.`);
    }
    notes.push('Los enlaces de pago ya generados conservan la cuota y el reparto con que se crearon.');

    const confirmed = await this.confirmAction({
      title: 'Confirmar cambios',
      bodyHtml: `<ul>${this.describeChanges(changes)}</ul>${notes.map((n) => `<p class="muted">${n}</p>`).join('')}`,
      confirmLabel: 'Guardar cambios',
      danger: forced,
      requireText: forced ? 'CONFIRMAR' : undefined
    });
    if (!confirmed) return;

    const dto: Record<string, unknown> = { ...this.readConfigForm() };
    if (forced) {
      dto.force = true;
      dto.reason = reason;
    }

    const fb = el('config-feedback');
    if (fb) fb.textContent = 'Guardando…';
    try {
      const { ok, status, data } = await this.api('/api/admin/config', dto);
      if (status === 401) return;
      if (!ok || !data.success) {
        this.toast(data.error || 'No se pudo guardar la configuración.', 'error');
        if (fb) {
          fb.textContent = data.error || 'Error al guardar';
          fb.className = 'feedback is-error';
        }
        if (status === 409) await this.loadDashboard();
        return;
      }
      this.toast(`Configuración guardada (${changes.length} cambio(s)).`);
      await this.loadDashboard();
      if (this.data) this.populateConfigForm(this.data.active_config, true);
    } catch (err) {
      this.toast(`Error de conexión: ${(err as Error).message}`, 'error');
    }
  }

  private renderConfigHistory(history: ConfigChangeRecord[]): void {
    const tbody = el('table-config-history');
    if (!tbody) return;
    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin cambios registrados.</td></tr>';
      return;
    }
    tbody.innerHTML = history
      .map(
        (h) => `
          <tr>
            <td class="small">${escapeHtml(new Date(h.changed_at).toLocaleString())}${h.forced ? '<span class="tag tag-warn">Forzado</span>' : ''}</td>
            <td><ul class="small" style="list-style:none">${this.describeChanges(h.changes)}</ul></td>
            <td class="num">${h.registered_couples_at_change}</td>
            <td class="small">${h.reason ? escapeHtml(h.reason) : '<span class="muted">—</span>'}</td>
            <td class="mono">${escapeHtml(h.admin_ip)}</td>
          </tr>`
      )
      .join('');
  }

  // -------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------

  private async handleCreateReferral(): Promise<void> {
    const codeEl = el<HTMLInputElement>('ref-code-input');
    const nameEl = el<HTMLInputElement>('ref-name-input');
    const phoneEl = el<HTMLInputElement>('ref-phone-input');
    const fb = el('ref-form-feedback');
    if (!codeEl || !nameEl) return;

    const referral_code = codeEl.value.trim().toUpperCase();
    try {
      const { ok, status, data } = await this.api('/api/admin/referrals', {
        referral_code,
        collaborator_name: nameEl.value.trim(),
        collaborator_payphone_number: phoneEl?.value.trim() || ''
      });
      if (status === 401) return;
      if (!ok || !data.success) {
        if (fb) {
          fb.textContent = data.error || 'No se pudo registrar el afiliado.';
          fb.className = 'feedback is-error';
        }
        return;
      }
      if (fb) {
        fb.textContent = `Afiliado ${referral_code} creado.`;
        fb.className = 'feedback is-ok';
      }
      codeEl.value = '';
      nameEl.value = '';
      if (phoneEl) phoneEl.value = '';
      await this.loadDashboard();
    } catch (err) {
      this.toast(`Error de conexión: ${(err as Error).message}`, 'error');
    }
  }

  private async handleSettleReferral(ref: ReferralRecord): Promise<void> {
    const confirmed = await this.confirmAction({
      title: 'Marcar comisión como pagada',
      bodyHtml: `<p>Registra que ya pagaste <strong>${usd(ref.pending_earnings_usd)}</strong> a <strong>${escapeHtml(ref.collaborator_name)}</strong> (${escapeHtml(ref.collaborator_payphone_number || 'sin teléfono')}).</p><p class="muted">Esto no envía dinero: solo actualiza el saldo pendiente.</p>`,
      confirmLabel: 'Marcar como pagado'
    });
    if (!confirmed) return;
    try {
      const { ok, status, data } = await this.api(`/api/admin/referrals/${encodeURIComponent(ref.id)}/settle`, {});
      if (status === 401) return;
      if (!ok || !data.success) {
        this.toast(data.error || 'No se pudo liquidar.', 'error');
        return;
      }
      this.toast(`Comisión de ${ref.referral_code} marcada como pagada.`);
      await this.loadDashboard();
    } catch (err) {
      this.toast(`Error de conexión: ${(err as Error).message}`, 'error');
    }
  }

  private async handleCloseTournament(): Promise<void> {
    const t = this.data?.tournament;
    const fin = this.data?.financial_summary;
    const confirmed = await this.confirmAction({
      title: 'Cerrar torneo',
      bodyHtml: `<p>Se cierra <strong>${escapeHtml(t?.name || 'el torneo')}</strong> con ${t?.registered_couples_count ?? 0} parejas, un pozo de <strong>${usd(fin?.prize_pool_total)}</strong> y <strong>${usd(fin?.charity_total)}</strong> para el refugio.</p><p class="muted">No se aceptarán más inscripciones y no se puede deshacer.</p>`,
      confirmLabel: 'Cerrar torneo',
      danger: true,
      requireText: 'CERRAR'
    });
    if (!confirmed) return;

    try {
      const { ok, status, data } = await this.api('/api/admin/tournament/close-podium', {});
      if (status === 401) return;
      if (!ok || !data.success) {
        this.toast(data.error || 'No se pudo cerrar el torneo.', 'error');
        return;
      }
      const podium = data.podium_distribution || {};
      const report = el('tournament-closure-report');
      if (report) {
        report.innerHTML = `
          <p><strong>Torneo cerrado.</strong> Pozo repartido: ${usd(podium.total_distributed)}</p>
          <p>1.º ${usd(podium.first_place)} · 2.º ${usd(podium.second_place)} · 3.º ${usd(podium.third_place)}</p>
          <p>Refugio animal: ${usd(data.charity_total_usd)}</p>`;
      }
      this.toast('Torneo cerrado y podio liquidado.');
      await this.loadDashboard();
    } catch (err) {
      this.toast(`Error de conexión: ${(err as Error).message}`, 'error');
    }
  }

  private async handleClearSecurityLogs(): Promise<void> {
    const confirmed = await this.confirmAction({
      title: 'Limpiar registros de seguridad',
      bodyHtml: '<p>Se borran los eventos mostrados. Los pagos y el historial de configuración no se tocan.</p>',
      confirmLabel: 'Limpiar',
      danger: true
    });
    if (!confirmed) return;
    const { ok } = await this.api('/api/admin/anticheat/clear', {});
    if (ok) await this.loadDashboard();
  }

  private exportPaymentsCSV(): void {
    if (this.currentPayments.length === 0) {
      this.toast('No hay pagos para exportar.', 'error');
      return;
    }
    const headers = [
      'ID_Transaccion_Payphone', 'Fecha', 'Piloto', 'Navegante', 'Monto_Bruto_USD', 'Comision_Payphone_USD',
      'Pozo_Premios_USD', 'Donacion_Refugio_USD', 'Margen_Plataforma_USD', 'Comision_Afiliado_USD',
      'Codigo_Referido', 'Pase_Torneo', 'Estado'
    ];
    const rows = this.currentPayments.map((p) => [
      p.payphone_transaction_id,
      p.created_at,
      p.pair_driver_name,
      p.pair_navigator_name,
      p.gross_amount.toFixed(2),
      p.payphone_fee.toFixed(2),
      p.prize_pool_share.toFixed(2),
      p.charity_share.toFixed(2),
      (p.developer_share + (p.referral_id ? 0 : p.collaborator_share)).toFixed(2),
      (p.referral_id ? p.collaborator_share : 0).toFixed(2),
      p.referral_code || 'N/A',
      p.pass_token || '',
      p.status
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `pacific_speed_pagos_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  private setText(id: string, text: string): void {
    const node = el(id);
    if (node) node.textContent = text;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PacificSpeedAdminApp();
});
