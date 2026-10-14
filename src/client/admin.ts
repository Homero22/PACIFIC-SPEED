import { escapeHtml } from '../shared/escapeHtml.js';
import type { TournamentFinancialConfig } from '../shared/financialConfig.js';
import type {
  AdminDashboardData,
  PaymentAuditRecord,
  ReferralRecord,
  SecurityAuditLog
} from '../shared/types.js';

const money = (v: unknown) => Number(v || 0).toFixed(2);

// Prevents CSV/formula injection when the export is opened in Excel/Sheets
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

class PacificSpeedAdminApp {
  private token: string | null = null;
  private dashboardData: AdminDashboardData | null = null;
  private currentPayments: PaymentAuditRecord[] = [];

  constructor() {
    this.token =
      sessionStorage.getItem('ps_admin_token') ||
      localStorage.getItem('ps_admin_token');

    this.bindEvents();

    if (this.token) {
      void this.loadDashboard();
    } else {
      this.showLoginView();
    }
  }

  private showLoginView(): void {
    document.getElementById('view-login')?.classList.remove('hidden');
    document.getElementById('view-dashboard')?.classList.add('hidden');
  }

  private showDashboardView(): void {
    document.getElementById('view-login')?.classList.add('hidden');
    document.getElementById('view-dashboard')?.classList.remove('hidden');
  }

  private bindEvents(): void {
    // 1. Login Form Submit
    document.getElementById('form-login')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleLogin();
    });

    // 2. Logout Button
    document.getElementById('btn-logout')?.addEventListener('click', () => {
      this.handleLogout();
    });

    // 3. Refresh Button
    document.getElementById('btn-refresh-data')?.addEventListener('click', async () => {
      await this.loadDashboard();
    });

    // 4. Tab Navigation
    document.querySelectorAll<HTMLAnchorElement>('.nav-link[data-tab]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetTab = link.dataset.tab;
        if (!targetTab) return;

        document.querySelectorAll('.nav-link[data-tab]').forEach((l) => l.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));

        link.classList.add('active');
        document.getElementById(targetTab)?.classList.remove('hidden');
      });
    });

    // 5. Payments Live Search
    document.getElementById('search-payments')?.addEventListener('input', (e) => {
      const term = (e.target as HTMLInputElement).value.toLowerCase().trim();
      this.renderPaymentsTable(term);
    });

    // 6. Payments CSV Export
    document.getElementById('btn-export-csv')?.addEventListener('click', () => {
      this.exportPaymentsCSV();
    });

    // 7. Add Referral Form
    document.getElementById('form-create-referral')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleCreateReferral();
    });

    // 8. Dynamic Config Form
    document.getElementById('form-config')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleSaveConfig();
    });

    // 9. Close Tournament Action
    document.getElementById('btn-close-tournament-action')?.addEventListener('click', async () => {
      await this.handleCloseTournament();
    });

    // 10. Clear Security Logs
    document.getElementById('btn-clear-security-logs')?.addEventListener('click', async () => {
      await this.handleClearSecurityLogs();
    });
  }

  private async handleLogin(): Promise<void> {
    const input = document.getElementById('login-password') as HTMLInputElement | null;
    const errorBox = document.getElementById('login-error-box');
    const submitBtn = document.getElementById('btn-login-submit') as HTMLButtonElement | null;

    if (!input) return;
    const password = input.value.trim();

    if (errorBox) {
      errorBox.textContent = '';
      errorBox.style.display = 'none';
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verificando credenciales...';
    }

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
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
        submitBtn.textContent = 'Acceder a la Consola';
      }
    }
  }

  private handleLogout(): void {
    this.token = null;
    sessionStorage.removeItem('ps_admin_token');
    localStorage.removeItem('ps_admin_token');
    this.showLoginView();
  }

  private async loadDashboard(): Promise<void> {
    if (!this.token) {
      this.showLoginView();
      return;
    }

    try {
      const res = await fetch('/api/admin/dashboard', {
        headers: { Authorization: `Bearer ${this.token}` }
      });

      if (res.status === 401) {
        this.handleLogout();
        const errBox = document.getElementById('login-error-box');
        if (errBox) {
          errBox.textContent = 'Tu sesión ha expirado. Por favor ingresa la clave de nuevo.';
          errBox.style.display = 'block';
        }
        return;
      }

      if (!res.ok) {
        throw new Error(`Error en servidor: ${res.statusText}`);
      }

      const data: AdminDashboardData = await res.json();
      this.dashboardData = data;
      this.currentPayments = data.payments_audit || [];

      this.showDashboardView();
      this.renderDashboard(data);
    } catch (err) {
      console.error('[Admin] Error cargando dashboard:', err);
    }
  }

  private renderDashboard(data: AdminDashboardData): void {
    const fin = data.financial_summary;
    const tourney = data.tournament;
    const cfg = data.active_config;

    // 1. Overview KPIs
    this.setText('kpi-gross', `$${fin.gross_collected_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    this.setText('kpi-prize-pool', `$${fin.prize_pool_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    this.setText('kpi-charity', `$${fin.charity_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    this.setText('kpi-developer', `$${fin.developer_net_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    this.setText('kpi-collaborators', `$${fin.collaborator_payouts_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    this.setText('kpi-payphone-fee', `$${fin.payphone_fees_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

    // Status Badge
    const statusBadge = document.getElementById('overview-status-badge');
    if (statusBadge) {
      const isCompleted = tourney.status === 'completed';
      statusBadge.textContent = isCompleted ? 'Torneo Completado' : 'Torneo Activo';
      statusBadge.className = `badge ${isCompleted ? 'badge-neutral' : 'badge-success'}`;
    }

    // Live Podium Preview
    const p1Amt = fin.prize_pool_total * cfg.prize_podium_breakdown.first_place_percentage;
    const p2Amt = fin.prize_pool_total * cfg.prize_podium_breakdown.second_place_percentage;
    const p3Amt = fin.prize_pool_total * cfg.prize_podium_breakdown.third_place_percentage;

    this.setText('overview-podium-1', `$${p1Amt.toFixed(2)} USD`);
    this.setText('overview-podium-2', `$${p2Amt.toFixed(2)} USD`);
    this.setText('overview-podium-3', `$${p3Amt.toFixed(2)} USD`);

    const topTeams = data.payments_audit.slice(0, 3);
    this.setText('overview-podium-1-team', topTeams[0] ? `${topTeams[0].pair_driver_name} / ${topTeams[0].pair_navigator_name}` : 'Sin pareja inscrita');
    this.setText('overview-podium-2-team', topTeams[1] ? `${topTeams[1].pair_driver_name} / ${topTeams[1].pair_navigator_name}` : 'Sin pareja inscrita');
    this.setText('overview-podium-3-team', topTeams[2] ? `${topTeams[2].pair_driver_name} / ${topTeams[2].pair_navigator_name}` : 'Sin pareja inscrita');

    // 2. Tournament Tab
    this.setText('tourney-panel-name', tourney.name);
    this.setText('tourney-panel-couples', `${tourney.registered_couples_count} / ${tourney.max_couples} parejas`);
    this.setText('tourney-panel-fee', `$${tourney.entry_fee_usd.toFixed(2)} USD`);

    // 3. Payments Ledger
    this.renderPaymentsTable('');

    // 4. Referrals Tab
    this.renderReferralsTable(data.referrals || []);

    // 5. Dynamic Config Form
    this.populateConfigForm(cfg);

    // 6. Security Logs Table
    this.renderSecurityTable(data.security_logs || []);
  }

  private renderPaymentsTable(filterTerm = ''): void {
    const tbody = document.getElementById('table-payments-body');
    if (!tbody) return;

    let items = this.currentPayments;
    if (filterTerm) {
      items = items.filter(
        (p) =>
          p.payphone_transaction_id.toLowerCase().includes(filterTerm) ||
          p.pair_driver_name.toLowerCase().includes(filterTerm) ||
          p.pair_navigator_name.toLowerCase().includes(filterTerm) ||
          (p.referral_code && p.referral_code.toLowerCase().includes(filterTerm))
      );
    }

    if (items.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">
            ${filterTerm ? 'No se encontraron pagos con ese criterio de búsqueda.' : 'No hay pagos procesados todavía.'}
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = items
      .map((p) => {
        const isApproved = p.status === 'APPROVED';
        return `
          <tr>
            <td class="text-mono" style="color: #60a5fa;" title="${escapeHtml(p.payphone_transaction_id)}">
              ${escapeHtml(p.payphone_transaction_id.slice(0, 16))}...
              ${p.pass_token ? `<div style="color: var(--text-muted); font-size: 11px;" title="Pase de torneo">${escapeHtml(p.pass_token)}</div>` : ''}
            </td>
            <td style="color: var(--text-muted); font-size: 12px;">
              ${escapeHtml(new Date(p.created_at).toLocaleString())}
            </td>
            <td>
              <strong>${escapeHtml(p.pair_driver_name)}</strong> / ${escapeHtml(p.pair_navigator_name)}
            </td>
            <td style="font-weight: 700;">$${money(p.gross_amount)}</td>
            <td style="color: #f87171;">$${money(p.payphone_fee)}</td>
            <td style="color: #10b981; font-weight: 600;">$${money(p.prize_pool_share)}</td>
            <td style="color: #06b6d4;">$${money(p.charity_share)}</td>
            <td style="color: #818cf8;">$${money(p.developer_share)}</td>
            <td style="color: #fbbf24;">
              ${escapeHtml(p.referral_code || '--')} ($${money(p.collaborator_share)})
            </td>
            <td>
              <span class="badge ${isApproved ? 'badge-success' : 'badge-danger'}">
                ${escapeHtml(p.status)}
              </span>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  private renderReferralsTable(referrals: ReferralRecord[]): void {
    const tbody = document.getElementById('table-referrals-body');
    if (!tbody) return;

    if (referrals.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">
            No hay colaboradores registrados actualmente.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = referrals
      .map((r) => {
        const hasPending = r.pending_earnings_usd > 0;
        return `
          <tr>
            <td><strong style="color: #60a5fa;">${escapeHtml(r.referral_code)}</strong></td>
            <td>${escapeHtml(r.collaborator_name)}</td>
            <td class="text-mono">${escapeHtml(r.collaborator_payphone_number || '--')}</td>
            <td style="text-align: center; font-weight: 600;">${Number(r.total_couples_referred) || 0}</td>
            <td>$${money(r.accumulated_earnings_usd)}</td>
            <td style="font-weight: 700; color: ${hasPending ? '#10b981' : 'var(--text-muted)'};">
              $${money(r.pending_earnings_usd)}
            </td>
            <td>
              ${
                hasPending
                  ? `<button class="btn-secondary btn-settle-payout" data-id="${escapeHtml(r.id)}" style="padding: 4px 10px; font-size: 11px; border-color: #10b981; color: #10b981;">
                      Liquidar Desembolso
                    </button>`
                  : '<span style="color: var(--text-subtle); font-size: 11px;">Al día</span>'
              }
            </td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll<HTMLButtonElement>('.btn-settle-payout').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (id) await this.handleSettleReferral(id);
      });
    });
  }

  private populateConfigForm(cfg: TournamentFinancialConfig): void {
    const isEditing = document.activeElement && document.activeElement.id && document.activeElement.id.startsWith('cfg-');
    if (isEditing) return;

    const setInput = (id: string, val: number) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = String(val);
    };

    setInput('cfg-entry-fee', cfg.entry_fee_per_pair);
    setInput('cfg-max-couples', cfg.max_couples_limit);
    setInput('cfg-prize-pool', cfg.pricing_structure.revenue_allocation_percentages.prize_pool.percentage_of_gross);
    setInput('cfg-charity', cfg.pricing_structure.revenue_allocation_percentages.animal_charity.percentage_of_gross);
    setInput('cfg-payphone-fee', cfg.pricing_structure.payphone_gateway.percentage_fee);
    setInput('cfg-dev-share', cfg.pricing_structure.margin_sub_distribution.platform_developer_share.percentage_of_operating_margin);
  }

  private renderSecurityTable(logs: SecurityAuditLog[]): void {
    const tbody = document.getElementById('table-security-body');
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: #10b981; padding: 24px;">
            ✓ Sistema íntegro. No hay violaciones de red ni eventos anti-cheat registrados.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = logs
      .map((log) => {
        const badgeClass =
          log.severity === 'critical'
            ? 'badge-danger'
            : log.severity === 'high'
            ? 'badge-warning'
            : 'badge-neutral';

        return `
          <tr>
            <td style="color: var(--text-muted); font-size: 12px;">
              ${escapeHtml(new Date(log.timestamp).toLocaleString())}
            </td>
            <td><span class="badge ${badgeClass}">${escapeHtml(log.severity)}</span></td>
            <td><strong style="color: #60a5fa;">${escapeHtml(log.event_type)}</strong></td>
            <td class="text-mono">${escapeHtml(log.ip_address)}</td>
            <td style="font-size: 12px; color: var(--text-muted); max-width: 320px; word-break: break-word;">
              ${escapeHtml(log.details)}
            </td>
          </tr>
        `;
      })
      .join('');
  }

  private async handleCreateReferral(): Promise<void> {
    const codeEl = document.getElementById('ref-code-input') as HTMLInputElement | null;
    const nameEl = document.getElementById('ref-name-input') as HTMLInputElement | null;
    const phoneEl = document.getElementById('ref-phone-input') as HTMLInputElement | null;
    const fb = document.getElementById('ref-form-feedback');

    if (!codeEl || !nameEl) return;
    const referral_code = codeEl.value.trim().toUpperCase();
    const collaborator_name = nameEl.value.trim();
    const collaborator_payphone_number = phoneEl?.value.trim() || '';

    try {
      const res = await fetch('/api/admin/referrals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify({
          referral_code,
          collaborator_name,
          collaborator_payphone_number
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (fb) {
          fb.textContent = `❌ ${data.error || 'Error al registrar colaborador'}`;
          fb.style.color = 'var(--danger)';
        }
        return;
      }

      if (fb) {
        fb.textContent = `✓ Afiliado "${referral_code}" creado exitosamente.`;
        fb.style.color = 'var(--success)';
      }

      codeEl.value = '';
      nameEl.value = '';
      if (phoneEl) phoneEl.value = '';

      await this.loadDashboard();
    } catch (err) {
      if (fb) {
        fb.textContent = `Error: ${(err as Error).message}`;
        fb.style.color = 'var(--danger)';
      }
    }
  }

  private async handleSettleReferral(id: string): Promise<void> {
    if (!confirm('¿Confirmas la liquidación y desembolso de ganancias pendientes a este colaborador vía Payphone?')) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/referrals/${encodeURIComponent(id)}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify({})
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(`Error al liquidar: ${data.error || 'Operación fallida'}`);
        return;
      }

      await this.loadDashboard();
    } catch (err) {
      alert(`Error de conexión: ${(err as Error).message}`);
    }
  }

  private async handleSaveConfig(): Promise<void> {
    const fb = document.getElementById('config-feedback');
    const getVal = (id: string) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      return el ? parseFloat(el.value) : undefined;
    };

    const payload = {
      entry_fee_per_pair: getVal('cfg-entry-fee'),
      max_couples_limit: getVal('cfg-max-couples'),
      prize_pool_percentage: getVal('cfg-prize-pool'),
      charity_percentage: getVal('cfg-charity'),
      // The form shows the base Payphone fee (without IVA); the server derives the effective fee
      payphone_percentage_fee: getVal('cfg-payphone-fee'),
      developer_share_of_margin: getVal('cfg-dev-share')
    };

    if (fb) {
      fb.textContent = 'Guardando cambios en base de datos...';
      fb.style.color = 'var(--text-muted)';
    }

    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (fb) {
          fb.textContent = `❌ ${data.error || 'Error al guardar configuración'}`;
          fb.style.color = 'var(--danger)';
        }
        return;
      }

      if (fb) {
        fb.textContent = '✓ Configuración financiera actualizada en tiempo real (hot reload).';
        fb.style.color = 'var(--success)';
      }

      await this.loadDashboard();
    } catch (err) {
      if (fb) {
        fb.textContent = `Error: ${(err as Error).message}`;
        fb.style.color = 'var(--danger)';
      }
    }
  }

  private async handleCloseTournament(): Promise<void> {
    if (!confirm('⚠️ ACCIÓN IRREVERSIBLE: ¿Estás seguro de cerrar el torneo y liquidar el podio definitivo? Esta acción congelará el pozo y emitirá el certificado de reparto.')) {
      return;
    }

    try {
      const res = await fetch('/api/admin/tournament/close-podium', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` }
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(`Error al cerrar torneo: ${data.error || 'Operación fallida'}`);
        return;
      }

      const reportBox = document.getElementById('tournament-closure-report');
      if (reportBox) {
        const podium = data.podium_distribution || {};
        reportBox.innerHTML = `
          <div style="color: #10b981; font-weight: 700; margin-bottom: 8px;">✓ TORNEO LIQUIDADO EXITOSAMENTE</div>
          <div>Pozo Total Distribuido: <strong>$${money(podium.total_distributed)} USD</strong></div>
          <div>🥇 1er Lugar: <strong>$${money(podium.first_place)} USD</strong></div>
          <div>🥈 2do Lugar: <strong>$${money(podium.second_place)} USD</strong></div>
          <div>🥉 3er Lugar: <strong>$${money(podium.third_place)} USD</strong></div>
          <div>🐾 Donación Entregada a Refugio Animal: <strong>$${money(data.charity_total_usd)} USD</strong></div>
        `;
      }

      await this.loadDashboard();
    } catch (err) {
      alert(`Error de conexión: ${(err as Error).message}`);
    }
  }

  private async handleClearSecurityLogs(): Promise<void> {
    if (!confirm('¿Deseas vaciar los registros de eventos de seguridad?')) return;

    try {
      const res = await fetch('/api/admin/anticheat/clear', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` }
      });

      if (res.ok) {
        await this.loadDashboard();
      }
    } catch (err) {
      console.error(err);
    }
  }

  private exportPaymentsCSV(): void {
    if (!this.currentPayments || this.currentPayments.length === 0) {
      alert('No hay pagos registrados para exportar.');
      return;
    }

    const headers = [
      'ID_Transaccion_Payphone',
      'Fecha',
      'Piloto',
      'Navegante',
      'Monto_Bruto_USD',
      'Comision_Payphone_USD',
      'Pozo_Premios_USD',
      'Donacion_Refugio_USD',
      'Margen_Plataforma_USD',
      'Comision_Afiliado_USD',
      'Codigo_Referido',
      'Pase_Torneo',
      'Estado'
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
      p.developer_share.toFixed(2),
      p.collaborator_share.toFixed(2),
      p.referral_code || 'N/A',
      p.pass_token || '',
      p.status
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `PACIFIC_SPEED_PAYMENTS_AUDIT_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  private setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PacificSpeedAdminApp();
});
