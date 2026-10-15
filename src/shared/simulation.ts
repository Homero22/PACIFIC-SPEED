import {
  checkAABB,
  checkCircleToLine,
  clamp,
  clampVector,
  getClosestLane,
  getLaneCenterX,
  TRACK_CONFIG
} from './math.js';
import {
  computeCollisionDamage,
  computeTotalScore,
  computeVehicleSpeed,
  GAMEPLAY_CONSTANTS,
  updateSelfDestructCountdown
} from './rules.js';
import type {
  ClientInputPayload,
  LaneIndex,
  ObstacleEntity,
  ObstacleType,
  PlayerRole,
  ServerWorldStatePayload,
  SoundEvent,
  SoundEventType,
  TacticalPing
} from './types.js';

export class GameSimulation {
  private tickCount = 0;
  private status: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover' = 'lobby';
  private distanceTraveled = 0;
  private survivalTime = 0;
  private totalScore = 0;
  private integrity: number = GAMEPLAY_CONSTANTS.MAX_INTEGRITY;
  private selfDestructTimer: number | null = null;
  private isOverdrive = false;
  private overdriveTimer = 0;
  private adReviveUsed = false;
  private collisionPenalty = 0;

  private shieldLeft = false;
  private shieldRight = false;
  private lastShieldSoundAt = -Infinity;
  private shieldEnergy: number = GAMEPLAY_CONSTANTS.MAX_SHIELD_ENERGY;
  private radarRevealTimer = 0;

  private mechaX: number = getLaneCenterX(1);
  private mechaY: number = TRACK_CONFIG.MECHA_DEFAULT_Y;
  private mechaVx = 0;
  private mechaVy = 0;
  private currentSpeed: number = GAMEPLAY_CONSTANTS.BASE_SPEED;

  private obstacles: ObstacleEntity[] = [];
  private activePings: TacticalPing[] = [];
  private recentEvents: SoundEvent[] = [];

  private driverInput = { x: 0, y: 0 };
  private navigatorFlags = {
    shield_left: false,
    shield_right: false,
    radar_pulse: false,
    ping_lane: null as LaneIndex | null
  };

  private spawnCooldown = 1.1;
  private entityCounter = 0;
  private lastPingLane: LaneIndex | null = null;
  private pingCooldown = 0;

  constructor(autoStart = false) {
    if (autoStart) {
      this.startMatch();
    }
  }

  public startMatch(): void {
    this.tickCount = 0;
    this.status = 'running';
    this.distanceTraveled = 0;
    this.survivalTime = 0;
    this.totalScore = 0;
    this.integrity = GAMEPLAY_CONSTANTS.MAX_INTEGRITY;
    this.selfDestructTimer = null;
    this.isOverdrive = false;
    this.overdriveTimer = 0;
    this.adReviveUsed = false;
    this.collisionPenalty = 0;

    this.shieldLeft = false;
    this.shieldRight = false;
    this.lastShieldSoundAt = -Infinity;
    this.shieldEnergy = GAMEPLAY_CONSTANTS.MAX_SHIELD_ENERGY;
    this.radarRevealTimer = 0;

    this.mechaX = getLaneCenterX(1);
    this.mechaY = TRACK_CONFIG.MECHA_DEFAULT_Y;
    this.mechaVx = 0;
    this.mechaVy = 0;
    this.currentSpeed = GAMEPLAY_CONSTANTS.BASE_SPEED;

    this.obstacles = [];
    this.activePings = [];
    this.recentEvents = [];
    this.spawnCooldown = 1.0;
    this.pingCooldown = 0;
  }

  public setStatus(status: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover'): void {
    this.status = status;
  }

  public getStatus(): 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover' {
    return this.status;
  }

  public applyPlayerInput(input: ClientInputPayload): void {
    if (input.role === 'driver') {
      this.driverInput.x = clamp(input.input_vector.x, -1, 1);
      this.driverInput.y = clamp(input.input_vector.y, -1, 1);
    } else if (input.role === 'navigator') {
      this.navigatorFlags.shield_left = Boolean(input.action_flags.shield_left);
      this.navigatorFlags.shield_right = Boolean(input.action_flags.shield_right);
      if (input.action_flags.radar_pulse) {
        this.navigatorFlags.radar_pulse = true;
      }
      if (input.action_flags.ping_lane !== null) {
        this.navigatorFlags.ping_lane = input.action_flags.ping_lane;
      }
    }
  }

  /**
   * AI Co-Pilot logic for solo practice mode.
   */
  public updateBotCoPilot(botRole: PlayerRole): void {
    if (this.status !== 'running') return;

    if (botRole === 'navigator') {
      let needLeft = false;
      let needRight = false;
      const blockedLanes = new Set<LaneIndex>();

      for (const obs of this.obstacles) {
        const distY = this.mechaY - obs.y;
        if (distY > -60 && distY < 220) {
          if (obs.side_threat === 'left') needLeft = true;
          if (obs.side_threat === 'right') needRight = true;
        }
        if (obs.type === 'barrier' && distY > 0 && distY < 480) {
          blockedLanes.add(obs.lane);
        }
      }

      this.navigatorFlags.shield_left = needLeft;
      this.navigatorFlags.shield_right = needRight;

      // Ping a safe lane if current mecha lane has an upcoming barrier
      const currentLane = getClosestLane(this.mechaX);
      if (blockedLanes.has(currentLane) && this.pingCooldown <= 0) {
        const safeLanes: LaneIndex[] = ([0, 1, 2] as LaneIndex[]).filter((l) => !blockedLanes.has(l));
        if (safeLanes.length > 0) {
          this.navigatorFlags.ping_lane = safeLanes[0];
        }
      }
    } else if (botRole === 'driver') {
      // Bot Driver follows Navigator pings or dodges nearby barriers
      let targetLane: LaneIndex = getClosestLane(this.mechaX);
      if (this.activePings.length > 0) {
        targetLane = this.activePings[this.activePings.length - 1].lane;
      } else {
        const currentLane = getClosestLane(this.mechaX);
        const dangerInCurrent = this.obstacles.some(
          (o) => o.type === 'barrier' && o.lane === currentLane && this.mechaY - o.y > 0 && this.mechaY - o.y < 260
        );
        if (dangerInCurrent) {
          const safe = ([0, 1, 2] as LaneIndex[]).find(
            (l) => !this.obstacles.some((o) => o.type === 'barrier' && o.lane === l && Math.abs(this.mechaY - o.y) < 280)
          );
          if (safe !== undefined) targetLane = safe;
        }
      }

      const targetX = getLaneCenterX(targetLane);
      const diffX = targetX - this.mechaX;
      this.driverInput.x = clamp(diffX / 45, -1, 1);
      this.driverInput.y = 0.35; // Keep healthy throttle above threshold
    }
  }

  public reviveWithRewardedAd(): boolean {
    if (this.status !== 'ad_revive_prompt' || this.adReviveUsed) {
      return false;
    }
    this.adReviveUsed = true;
    this.integrity = GAMEPLAY_CONSTANTS.MAX_INTEGRITY;
    this.selfDestructTimer = null;
    this.collisionPenalty = 0;
    this.currentSpeed = Math.max(this.currentSpeed, 135);
    this.shieldEnergy = GAMEPLAY_CONSTANTS.MAX_SHIELD_ENERGY;
    this.obstacles = []; // Clear immediate hazards around the Mecha
    this.status = 'running';
    this.emitSound('revive');
    return true;
  }

  public declineRewardedAd(): void {
    if (this.status === 'ad_revive_prompt') {
      this.status = 'gameover';
    }
  }

  public forcePenaltyForTest(penalty: number, integrity?: number): void {
    this.collisionPenalty = penalty;
    if (integrity !== undefined) {
      this.integrity = integrity;
    }
  }

  public spawnObstacleForTest(obstacle: ObstacleEntity): void {
    this.obstacles.push(obstacle);
  }

  public step(dt: number = GAMEPLAY_CONSTANTS.FIXED_DT): ServerWorldStatePayload {
    if (this.status !== 'running') {
      return this.getWorldStatePayload();
    }

    this.tickCount++;
    this.survivalTime += dt;

    // 1. Recover collision penalty gradually over time
    if (this.collisionPenalty > 0) {
      this.collisionPenalty = Math.max(
        0,
        this.collisionPenalty - GAMEPLAY_CONSTANTS.PENALTY_RECOVERY_PER_SECOND * dt
      );
    }

    // 2. Update Overdrive timer
    if (this.isOverdrive) {
      this.overdriveTimer = Math.max(0, this.overdriveTimer - dt);
      if (this.overdriveTimer <= 0) {
        this.isOverdrive = false;
      }
    }

    // 3. Calculate vehicle speed using exact gameplay formula
    const overdriveBonus = this.isOverdrive ? 30 : 0;
    this.currentSpeed = clamp(
      computeVehicleSpeed(this.distanceTraveled, this.collisionPenalty, this.driverInput.y) +
        overdriveBonus,
      0,
      GAMEPLAY_CONSTANTS.MAX_SPEED
    );

    // Advance distance (scaled so distance grows smoothly in meters/units)
    const distanceDelta = (this.currentSpeed * dt) / 10;
    this.distanceTraveled += distanceDelta;

    // 4. Update Mecha 2D vector movement with clamped velocity
    const lateralSpeed = 310;
    const verticalAdjustSpeed = 160;
    const rawVel = clampVector(
      {
        x: this.driverInput.x * lateralSpeed,
        y: -this.driverInput.y * verticalAdjustSpeed
      },
      lateralSpeed
    );

    this.mechaVx = rawVel.x;
    this.mechaVy = rawVel.y;
    this.mechaX = clamp(
      this.mechaX + this.mechaVx * dt,
      TRACK_CONFIG.ROAD_LEFT + TRACK_CONFIG.MECHA_WIDTH * 0.55,
      TRACK_CONFIG.ROAD_RIGHT - TRACK_CONFIG.MECHA_WIDTH * 0.55
    );
    this.mechaY = clamp(
      this.mechaY + this.mechaVy * dt,
      TRACK_CONFIG.MECHA_MIN_Y,
      TRACK_CONFIG.MECHA_MAX_Y
    );

    // 5. Process Navigator Shields & Energy
    const wantsLeft = this.navigatorFlags.shield_left;
    const wantsRight = this.navigatorFlags.shield_right;
    const activeCount = (wantsLeft ? 1 : 0) + (wantsRight ? 1 : 0);
    const prevShieldCount = (this.shieldLeft ? 1 : 0) + (this.shieldRight ? 1 : 0);

    if (activeCount > 0 && this.shieldEnergy > 1) {
      this.shieldLeft = wantsLeft;
      this.shieldRight = wantsRight;
      const drain = GAMEPLAY_CONSTANTS.SHIELD_DRAIN_PER_SECOND * (activeCount === 2 ? 1.65 : 1.0) * dt;
      this.shieldEnergy = Math.max(0, this.shieldEnergy - drain);
      if (this.shieldEnergy <= 0) {
        this.shieldLeft = false;
        this.shieldRight = false;
      }
    } else {
      this.shieldLeft = false;
      this.shieldRight = false;
      this.shieldEnergy = Math.min(
        GAMEPLAY_CONSTANTS.MAX_SHIELD_ENERGY,
        this.shieldEnergy + GAMEPLAY_CONSTANTS.SHIELD_RECHARGE_PER_SECOND * dt
      );
    }

    // Sonido al encender escudos (flanco de subida, con pausa mínima para no repetir al alternar)
    const shieldCount = (this.shieldLeft ? 1 : 0) + (this.shieldRight ? 1 : 0);
    if (shieldCount > prevShieldCount) {
      const minGap = shieldCount === 2 ? 1.0 : 0.35;
      if (this.survivalTime - this.lastShieldSoundAt >= minGap) {
        this.lastShieldSoundAt = this.survivalTime;
        const pan = shieldCount === 2 ? 0 : this.shieldLeft ? -0.6 : 0.6;
        this.emitSound(shieldCount === 2 ? 'shield_double' : 'shield_up', { pan });
      }
    }

    // 6. Process Navigator Radar Pulse & Tactical Pings
    if (this.navigatorFlags.radar_pulse) {
      this.navigatorFlags.radar_pulse = false;
      if (this.shieldEnergy >= GAMEPLAY_CONSTANTS.RADAR_PULSE_COST) {
        this.shieldEnergy -= GAMEPLAY_CONSTANTS.RADAR_PULSE_COST;
        this.radarRevealTimer = GAMEPLAY_CONSTANTS.RADAR_REVEAL_DURATION;
        this.emitSound('ping_deployed');
      }
    }
    if (this.radarRevealTimer > 0) {
      this.radarRevealTimer = Math.max(0, this.radarRevealTimer - dt);
    }

    if (this.pingCooldown > 0) {
      this.pingCooldown = Math.max(0, this.pingCooldown - dt);
    }
    if (this.navigatorFlags.ping_lane !== null && this.pingCooldown <= 0) {
      const lane = this.navigatorFlags.ping_lane;
      this.navigatorFlags.ping_lane = null;
      this.lastPingLane = lane;
      this.pingCooldown = 0.28;
      this.activePings.push({
        id: `ping-${++this.entityCounter}`,
        lane,
        x: getLaneCenterX(lane),
        y_offset: this.mechaY - 210,
        ttl: 2.2,
        max_ttl: 2.2
      });
      this.emitSound('ping_deployed');
    } else {
      this.navigatorFlags.ping_lane = null;
    }

    // Update active pings TTL
    for (let i = this.activePings.length - 1; i >= 0; i--) {
      this.activePings[i].ttl -= dt;
      if (this.activePings[i].ttl <= 0) {
        this.activePings.splice(i, 1);
      }
    }

    // 7. Spawn Procedural Obstacles
    this.spawnCooldown -= dt;
    if (this.spawnCooldown <= 0) {
      this.spawnWave();
      const speedFactor = clamp(this.currentSpeed / GAMEPLAY_CONSTANTS.BASE_SPEED, 0.7, 2.2);
      this.spawnCooldown = clamp(1.25 / speedFactor, 0.48, 1.35);
    }

    // 8. Move Obstacles & Check Collisions (AABB + Circle-to-Line)
    const mechaRect = {
      x: this.mechaX - TRACK_CONFIG.MECHA_WIDTH * 0.5,
      y: this.mechaY - TRACK_CONFIG.MECHA_HEIGHT * 0.5,
      width: TRACK_CONFIG.MECHA_WIDTH,
      height: TRACK_CONFIG.MECHA_HEIGHT
    };

    const leftShieldStart = {
      x: this.mechaX - TRACK_CONFIG.SHIELD_OFFSET_X,
      y: this.mechaY - TRACK_CONFIG.SHIELD_HALF_HEIGHT
    };
    const leftShieldEnd = {
      x: this.mechaX - TRACK_CONFIG.SHIELD_OFFSET_X,
      y: this.mechaY + TRACK_CONFIG.SHIELD_HALF_HEIGHT
    };
    const rightShieldStart = {
      x: this.mechaX + TRACK_CONFIG.SHIELD_OFFSET_X,
      y: this.mechaY - TRACK_CONFIG.SHIELD_HALF_HEIGHT
    };
    const rightShieldEnd = {
      x: this.mechaX + TRACK_CONFIG.SHIELD_OFFSET_X,
      y: this.mechaY + TRACK_CONFIG.SHIELD_HALF_HEIGHT
    };

    const scrollSpeedPx = this.currentSpeed * 2.35;

    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const obs = this.obstacles[i];
      obs.x += obs.vx * dt;
      obs.y += (scrollSpeedPx + obs.vy) * dt;

      // Homing behavior for lateral flank drones as they approach the Mecha's Y plane
      if (obs.side_threat === 'left' || obs.side_threat === 'right') {
        const dy = this.mechaY - obs.y;
        if (dy > -50 && dy < 260) {
          const dirX = Math.sign(this.mechaX - obs.x);
          obs.x += dirX * 145 * dt;
        }
      }

      const obsCircle = {
        x: obs.x,
        y: obs.y,
        radius: Math.max(obs.width, obs.height) * 0.5
      };

      // Check Circle-to-Line flank shield deflection first
      if (
        obs.side_threat === 'left' &&
        this.shieldLeft &&
        checkCircleToLine(obsCircle, leftShieldStart, leftShieldEnd)
      ) {
        this.emitSound('shield_deflect', { pan: this.panFor(obs.x) });
        this.obstacles.splice(i, 1);
        continue;
      }

      if (
        obs.side_threat === 'right' &&
        this.shieldRight &&
        checkCircleToLine(obsCircle, rightShieldStart, rightShieldEnd)
      ) {
        this.emitSound('shield_deflect', { pan: this.panFor(obs.x) });
        this.obstacles.splice(i, 1);
        continue;
      }

      // Check AABB collision with Mecha chassis
      const obsRect = {
        x: obs.x - obs.width * 0.5,
        y: obs.y - obs.height * 0.5,
        width: obs.width,
        height: obs.height
      };

      if (checkAABB(mechaRect, obsRect)) {
        if (obs.type === 'overdrive_cell') {
          this.isOverdrive = true;
          this.overdriveTimer = GAMEPLAY_CONSTANTS.OVERDRIVE_DURATION_SECONDS;
          this.collisionPenalty = Math.max(0, this.collisionPenalty - 35);
          this.emitSound('overdrive_activated', { pan: this.panFor(obs.x) });
        } else if (obs.type === 'repair_cell') {
          this.integrity = Math.min(
            GAMEPLAY_CONSTANTS.MAX_INTEGRITY,
            this.integrity + GAMEPLAY_CONSTANTS.REPAIR_CELL_BONUS
          );
          this.emitSound('repair_collected', { pan: this.panFor(obs.x) });
        } else {
          // Hazard collision: evaluate shield absorption formula
          const result = computeCollisionDamage(obs.side_threat, {
            left: this.shieldLeft,
            right: this.shieldRight
          });
          if (result.deflected) {
            this.emitSound('shield_deflect', { pan: this.panFor(obs.x) });
          } else {
            this.integrity = Math.max(0, this.integrity - result.damage);
            this.collisionPenalty += GAMEPLAY_CONSTANTS.COLLISION_SPEED_PENALTY;
            this.emitSound('collision_damage', {
              pan: this.panFor(obs.x),
              intensity: 1 - this.integrity / GAMEPLAY_CONSTANTS.MAX_INTEGRITY
            });
          }
        }
        this.obstacles.splice(i, 1);
        continue;
      }

      // Remove obstacles that passed off-screen
      if (obs.y > TRACK_CONFIG.WORLD_HEIGHT + 100) {
        this.obstacles.splice(i, 1);
      }
    }

    // 9. Update Self-Destruct Countdown (< 50 critical speed threshold)
    const sdState = updateSelfDestructCountdown(this.currentSpeed, this.selfDestructTimer, dt);
    this.selfDestructTimer = sdState.timer;

    // 10. Update Total Score formula
    this.totalScore = computeTotalScore(this.distanceTraveled, this.survivalTime, this.isOverdrive);

    // 11. Check Integrity or Self-Destruct Failure
    if (this.integrity <= 0 || sdState.exploded) {
      this.emitSound('explosion', { intensity: 1 });
      if (!this.adReviveUsed) {
        this.status = 'ad_revive_prompt';
      } else {
        this.status = 'gameover';
      }
    }

    return this.getWorldStatePayload();
  }

  private spawnWave(): void {
    const roll = Math.random();
    const lane = Math.floor(Math.random() * 3) as LaneIndex;

    if (roll < 0.42) {
      // Standard road barrier (sometimes double lane to require Navigator ping)
      this.createObstacle('barrier', lane, getLaneCenterX(lane), -60);
      if (Math.random() < 0.35 && this.distanceTraveled > 60) {
        const secondLane = ((lane + 1) % 3) as LaneIndex;
        this.createObstacle('barrier', secondLane, getLaneCenterX(secondLane), -60);
      }
    } else if (roll < 0.65) {
      // Left flank threat requiring Navigator Left Shield (J)
      this.createObstacle(
        'flank_left',
        0,
        TRACK_CONFIG.ROAD_LEFT - 25,
        -40,
        'left'
      );
    } else if (roll < 0.88) {
      // Right flank threat requiring Navigator Right Shield (L)
      this.createObstacle(
        'flank_right',
        2,
        TRACK_CONFIG.ROAD_RIGHT + 25,
        -40,
        'right'
      );
    } else if (roll < 0.95) {
      // Overdrive cell
      this.createObstacle('overdrive_cell', lane, getLaneCenterX(lane), -50);
    } else {
      // Repair cell
      this.createObstacle('repair_cell', lane, getLaneCenterX(lane), -50);
    }
  }

  private createObstacle(
    type: ObstacleType,
    lane: LaneIndex,
    x: number,
    y: number,
    sideThreat?: 'left' | 'right'
  ): void {
    const isBarrier = type === 'barrier';
    const isFlank = type === 'flank_left' || type === 'flank_right';
    this.obstacles.push({
      id: `obs-${++this.entityCounter}`,
      type,
      lane,
      x,
      y,
      width: isBarrier ? 96 : isFlank ? 38 : 42,
      height: isBarrier ? 34 : isFlank ? 38 : 42,
      vx: 0,
      vy: isFlank ? 75 : 0,
      side_threat: sideThreat
    });
  }

  /** Posición estéreo de un punto respecto al vehículo (-1 izquierda … 1 derecha). */
  private panFor(x: number): number {
    const halfRoad = (TRACK_CONFIG.ROAD_RIGHT - TRACK_CONFIG.ROAD_LEFT) / 2;
    return Number(clamp((x - this.mechaX) / halfRoad, -1, 1).toFixed(2));
  }

  private emitSound(type: SoundEventType, opts: { pan?: number; intensity?: number } = {}): void {
    this.recentEvents.push({
      id: `snd-${++this.entityCounter}-${this.tickCount}`,
      type,
      timestamp: Date.now(),
      ...(opts.pan !== undefined && { pan: opts.pan }),
      ...(opts.intensity !== undefined && { intensity: Number(opts.intensity.toFixed(2)) })
    });
    if (this.recentEvents.length > 12) {
      this.recentEvents.shift();
    }
  }

  public getWorldStatePayload(): ServerWorldStatePayload {
    const baseVis = this.isOverdrive
      ? GAMEPLAY_CONSTANTS.OVERDRIVE_VISIBILITY_RADIUS
      : GAMEPLAY_CONSTANTS.BASE_VISIBILITY_RADIUS;
    const visibilityRadius =
      this.radarRevealTimer > 0 ? GAMEPLAY_CONSTANTS.RADAR_PULSE_VISIBILITY_RADIUS : baseVis;

    const speedRatio = clamp(this.currentSpeed / GAMEPLAY_CONSTANTS.MAX_SPEED, 0, 1);

    return {
      tick: this.tickCount,
      timestamp: Date.now(),
      world_state: {
        status: this.status,
        distance_traveled: Number(this.distanceTraveled.toFixed(1)),
        survival_time: Number(this.survivalTime.toFixed(1)),
        total_score: this.totalScore,
        integrity: this.integrity,
        max_integrity: GAMEPLAY_CONSTANTS.MAX_INTEGRITY,
        self_destruct_timer:
          this.selfDestructTimer !== null ? Number(this.selfDestructTimer.toFixed(2)) : null,
        is_overdrive: this.isOverdrive,
        overdrive_timer: Number(this.overdriveTimer.toFixed(1)),
        ad_revive_used: this.adReviveUsed,
        collision_penalty: Number(this.collisionPenalty.toFixed(1)),
        active_shields: {
          left: this.shieldLeft,
          right: this.shieldRight,
          energy: Number(this.shieldEnergy.toFixed(1)),
          max_energy: GAMEPLAY_CONSTANTS.MAX_SHIELD_ENERGY
        },
        active_pings: [...this.activePings],
        events: [...this.recentEvents]
      },
      entity_positions: {
        mecha: {
          x: Number(this.mechaX.toFixed(1)),
          y: Number(this.mechaY.toFixed(1)),
          vx: Number(this.mechaVx.toFixed(1)),
          vy: Number(this.mechaVy.toFixed(1)),
          width: TRACK_CONFIG.MECHA_WIDTH,
          height: TRACK_CONFIG.MECHA_HEIGHT,
          radius: TRACK_CONFIG.MECHA_RADIUS,
          current_lane: getClosestLane(this.mechaX)
        },
        obstacles: this.obstacles.map((o) => ({ ...o }))
      },
      speed_multiplier: {
        current_speed: Number(this.currentSpeed.toFixed(1)),
        base_speed: GAMEPLAY_CONSTANTS.BASE_SPEED,
        max_speed: GAMEPLAY_CONSTANTS.MAX_SPEED,
        critical_threshold: GAMEPLAY_CONSTANTS.CRITICAL_SPEED_THRESHOLD,
        normalized: Number((this.currentSpeed / GAMEPLAY_CONSTANTS.BASE_SPEED).toFixed(2))
      },
      fog_matrix: {
        visibility_radius: visibilityRadius,
        tunnel_intensity: Number((0.68 + speedRatio * 0.24).toFixed(2)),
        radar_reveal_timer: Number(this.radarRevealTimer.toFixed(2))
      }
    };
  }
}
