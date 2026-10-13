import type { ClientInputPayload, SecurityAuditLog } from '../shared/types.js';

interface PlayerTelemetryState {
  lastTimestamp: number;
  lastX: number;
  lastY: number;
  shieldTogglesInWindow: number;
  shieldWindowStart: number;
  lastShieldState: boolean;
}

export class AntiCheatEngine {
  private playerStates = new Map<string, PlayerTelemetryState>();
  private securityLogs: SecurityAuditLog[] = [];

  public logSecurityViolation(
    eventType: SecurityAuditLog['event_type'],
    severity: SecurityAuditLog['severity'],
    ip: string,
    details: string
  ): void {
    const entry: SecurityAuditLog = {
      id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      event_type: eventType,
      severity,
      ip_address: ip || '127.0.0.1',
      details,
      timestamp: new Date().toISOString()
    };
    this.securityLogs.unshift(entry);
    if (this.securityLogs.length > 100) {
      this.securityLogs.length = 100;
    }
  }

  public getSecurityLogs(): SecurityAuditLog[] {
    return [...this.securityLogs];
  }

  public clearLogs(): void {
    this.securityLogs = [];
  }

  /**
   * Validates client input payload against 60Hz server-authoritative security rules.
   */
  public sanitizeClientInput(
    input: ClientInputPayload,
    currentServerX: number,
    currentServerY: number,
    clientIp = '127.0.0.1'
  ): { sanitized: ClientInputPayload; violated: boolean } {
    const sanitized: ClientInputPayload = {
      ...input,
      input_vector: { ...input.input_vector },
      action_flags: { ...input.action_flags }
    };
    let violated = false;

    // 1. Clamp Input Vector [-1, 1]
    const magSq =
      sanitized.input_vector.x * sanitized.input_vector.x +
      sanitized.input_vector.y * sanitized.input_vector.y;
    if (magSq > 2.01) {
      this.logSecurityViolation(
        'impossible_speed',
        'medium',
        clientIp,
        `Player ${input.player_id} sent abnormal input vector magnitude (${Math.sqrt(magSq).toFixed(2)})`
      );
      sanitized.input_vector.x = Math.max(-1, Math.min(1, sanitized.input_vector.x));
      sanitized.input_vector.y = Math.max(-1, Math.min(1, sanitized.input_vector.y));
      violated = true;
    }

    // 2. Validate Shield Activations Rate Limit (Max 3 toggles per second)
    const now = Date.now();
    let state = this.playerStates.get(input.player_id);
    if (!state) {
      state = {
        lastTimestamp: now,
        lastX: currentServerX,
        lastY: currentServerY,
        shieldTogglesInWindow: 0,
        shieldWindowStart: now,
        lastShieldState: false
      };
      this.playerStates.set(input.player_id, state);
    }

    if (now - state.shieldWindowStart > 1000) {
      state.shieldWindowStart = now;
      state.shieldTogglesInWindow = 0;
    }

    const currentShieldActive =
      Boolean(sanitized.action_flags.shield_left) || Boolean(sanitized.action_flags.shield_right);
    if (currentShieldActive !== state.lastShieldState) {
      state.shieldTogglesInWindow++;
      state.lastShieldState = currentShieldActive;

      if (state.shieldTogglesInWindow > 3) {
        this.logSecurityViolation(
          'shield_spam',
          'low',
          clientIp,
          `Player ${input.player_id} exceeded max 3 shield activations/sec (${state.shieldTogglesInWindow} toggles)`
        );
        sanitized.action_flags.shield_left = false;
        sanitized.action_flags.shield_right = false;
        violated = true;
      }
    }

    state.lastTimestamp = now;
    state.lastX = currentServerX;
    state.lastY = currentServerY;

    return { sanitized, violated };
  }

  public removePlayer(playerId: string): void {
    this.playerStates.delete(playerId);
  }
}

export const antiCheatEngine = new AntiCheatEngine();
