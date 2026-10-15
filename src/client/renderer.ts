import { getClosestLane, getLaneCenterX, lerp, TRACK_CONFIG } from '../shared/math.js';
import type {
  CosmeticLoadout,
  LaneIndex,
  PlayerRole,
  ServerWorldStatePayload,
  TacticalCommsEvent
} from '../shared/types.js';

interface SparkParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  size: number;
  color: string;
  isSmoke?: boolean;
}

interface ShockwaveRing {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  color: string;
}

interface FloatingCallout {
  text: string;
  subtext: string;
  x: number;
  y: number;
  alpha: number;
  color: string;
}

interface RainDrop {
  x: number;
  y: number;
  length: number;
  speed: number;
  alpha: number;
}

const PAINT_TINTS: Record<
  CosmeticLoadout['paintJob'],
  { primary: string; glow: string; afterburner: string }
> = {
  crimson_jaeger: { primary: '#ff2a54', glow: 'rgba(255, 42, 84, 0.55)', afterburner: '#ff4d00' },
  cyber_gold: { primary: '#ffb703', glow: 'rgba(255, 183, 3, 0.55)', afterburner: '#00f0ff' },
  phantom_stealth: { primary: '#00ff9d', glow: 'rgba(0, 255, 157, 0.55)', afterburner: '#7b2cbf' }
};

const TRAIL_COLORS: Record<CosmeticLoadout['neonTrail'], string> = {
  plasma_cyan: '#00f0ff',
  overdrive_magenta: '#ff007f',
  solar_flare: '#ff9e00'
};

export class GameRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private roadScrollY = 0;
  private radarSweepY = 0;

  private sparks: SparkParticle[] = [];
  private shockwaves: ShockwaveRing[] = [];
  private callouts: FloatingCallout[] = [];
  private rainDrops: RainDrop[] = [];

  private smoothMechaX: number = getLaneCenterX(1);
  private smoothMechaY: number = TRACK_CONFIG.MECHA_DEFAULT_Y;
  private smoothBankAngle = 0;

  // Screen shake state
  private shakeIntensity = 0;
  private processedSoundEventIds = new Set<string>();

  // Active holographic comms banner for 9:16 TikTok view
  private activeCommsBanner: { event: TacticalCommsEvent; ttl: number } | null = null;

  // Realistic image assets
  private roadTextureImg: HTMLImageElement | null = null;
  private roadTextureLoaded = false;
  private mechaCutoutCanvas: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D Canvas context not supported');
    this.ctx = context;

    this.canvas.width = TRACK_CONFIG.WORLD_WIDTH;
    this.canvas.height = TRACK_CONFIG.WORLD_HEIGHT;

    this.initRainSystem();
    this.loadRealisticAssets();
  }

  private initRainSystem(): void {
    for (let i = 0; i < 75; i++) {
      this.rainDrops.push({
        x: Math.random() * TRACK_CONFIG.WORLD_WIDTH,
        y: Math.random() * TRACK_CONFIG.WORLD_HEIGHT,
        length: 18 + Math.random() * 26,
        speed: 650 + Math.random() * 450,
        alpha: 0.12 + Math.random() * 0.22
      });
    }
  }

  private loadRealisticAssets(): void {
    const roadImg = new Image();
    roadImg.src = '/assets/asphalt_road.jpg';
    roadImg.onload = () => {
      this.roadTextureImg = roadImg;
      this.roadTextureLoaded = true;
    };

    const mechaImg = new Image();
    mechaImg.src = '/assets/mecha_unit.jpg';
    mechaImg.onload = () => {
      this.mechaCutoutCanvas = this.removeBlackBackground(mechaImg);
    };
  }

  /**
   * Converts the pure black background of the AI-generated realistic Mecha sprite
   * into smooth alpha transparency for seamless rendering over wet asphalt.
   */
  private removeBlackBackground(img: HTMLImageElement): HTMLCanvasElement {
    const off = document.createElement('canvas');
    off.width = img.width;
    off.height = img.height;
    const octx = off.getContext('2d');
    if (!octx) return off;

    octx.drawImage(img, 0, 0);
    const imgData = octx.getImageData(0, 0, off.width, off.height);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = Math.max(r, g, b);
      if (lum < 22) {
        data[i + 3] = 0;
      } else if (lum < 52) {
        data[i + 3] = Math.floor(((lum - 22) / 30) * 255);
      }
    }

    octx.putImageData(imgData, 0, 0);
    return off;
  }

  public showCommsBanner(event: TacticalCommsEvent): void {
    this.activeCommsBanner = {
      event,
      ttl: 3.4
    };
    this.shakeIntensity = Math.max(this.shakeIntensity, 4);
  }

  public triggerCustomCallout(text: string, subtext: string, color = '#00f0ff'): void {
    this.callouts.push({
      text,
      subtext,
      x: this.smoothMechaX,
      y: this.smoothMechaY - 78,
      alpha: 1.45,
      color
    });
  }

  public getLaneFromCanvasPoint(clientX: number): LaneIndex | null {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const worldX = (clientX - rect.left) * scaleX;
    if (worldX < TRACK_CONFIG.ROAD_LEFT || worldX > TRACK_CONFIG.ROAD_RIGHT) {
      return null;
    }
    return getClosestLane(worldX);
  }

  public render(
    state: ServerWorldStatePayload,
    activeRole: PlayerRole,
    cosmetics: CosmeticLoadout,
    predictedInputX: number,
    dt: number
  ): void {
    const { ctx } = this;
    const width = TRACK_CONFIG.WORLD_WIDTH;
    const height = TRACK_CONFIG.WORLD_HEIGHT;

    // Trigger VFX bursts from new server events
    this.consumeEventsForVFX(state);

    const speed = state.speed_multiplier.current_speed;
    this.roadScrollY = (this.roadScrollY + speed * 3.2 * dt) % height;
    this.radarSweepY = (this.radarSweepY + 380 * dt) % height;

    // Smooth Mecha interpolation + aerodynamic banking roll
    const targetX =
      state.entity_positions.mecha.x + (activeRole === 'driver' ? predictedInputX * 16 : 0);
    const targetY = state.entity_positions.mecha.y;
    const vxDelta = targetX - this.smoothMechaX;
    this.smoothMechaX = lerp(this.smoothMechaX, targetX, 0.32);
    this.smoothMechaY = lerp(this.smoothMechaY, targetY, 0.32);
    this.smoothBankAngle = lerp(this.smoothBankAngle, Math.max(-0.22, Math.min(0.22, vxDelta * 0.015)), 0.25);

    ctx.save();

    // Apply cockpit screen-shake on impacts/deflections
    if (this.shakeIntensity > 0.2) {
      const sx = (Math.random() - 0.5) * this.shakeIntensity * 2;
      const sy = (Math.random() - 0.5) * this.shakeIntensity * 2;
      ctx.translate(sx, sy);
      this.shakeIntensity = Math.max(0, this.shakeIntensity - 28 * dt);
    }

    // 1. Render Realistic Wet Highway Texture & Tactical Lane Grid
    this.drawRealisticHighway(state.world_state.is_overdrive, activeRole);

    // 2. Render Wet Asphalt Specular Reflections & Dual Afterburner Plumes
    this.drawAfterburnersAndParticles(cosmetics, speed, state.world_state.is_overdrive, dt);

    // 3. Render Detailed Obstacles, Cruise Missiles & Laser Lock Beams
    this.drawRealisticObstacles(state, activeRole);

    // 4. Render Stealth Mecha Sprite & Hexagonal Energy Shields
    this.drawRealisticMechaAndShields(state, cosmetics);

    // 5. Render Shockwave Rings & Physical Spark Debris
    this.updateAndDrawShockwaves(dt);

    // 6. Render High-Speed Atmospheric Rain
    this.updateAndDrawRain(speed, dt);

    // 7. Asymmetric Tactical Role Layer:
    // Driver gets Volumetric Headlight Cones + Night-Vision FLIR on Radar Pulse;
    // Navigator gets Full Overhead Stealth Fighter Radar HUD
    if (activeRole === 'driver') {
      this.drawDriverVolumetricLighting(state);
    } else {
      this.drawNavigatorStealthRadar(state);
    }

    // 8. Render Navigator Tactical Pings & Stealth Fighter HUD Telemetry (Compass, Pitch Ladder, Callouts)
    this.drawTacticalPings(state);
    this.drawStealthFighterCockpitHUD(state, activeRole);
    this.updateAndDrawCallouts(dt);

    // 9. Render Live 9:16 Holographic Comms Banner
    this.updateAndDrawCommsBanner(dt);

    // 10. Critical Velocity (< 50) Master Caution Strobe
    if (state.world_state.self_destruct_timer !== null) {
      this.drawCriticalSpeedWarning(state.world_state.self_destruct_timer);
    }

    ctx.restore();
  }

  private consumeEventsForVFX(state: ServerWorldStatePayload): void {
    for (const ev of state.world_state.events) {
      if (this.processedSoundEventIds.has(ev.id)) continue;
      this.processedSoundEventIds.add(ev.id);
      if (this.processedSoundEventIds.size > 60) {
        const first = this.processedSoundEventIds.values().next().value;
        if (first) this.processedSoundEventIds.delete(first);
      }

      if (ev.type === 'shield_deflect') {
        this.shakeIntensity = 9;
        this.spawnExplosionSparks(this.smoothMechaX, this.smoothMechaY - 10, '#00f0ff', 38);
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 25,
          maxRadius: 150,
          alpha: 1.0,
          color: '#00f0ff'
        });
        this.callouts.push({
          text: 'INTERCEPT CONFIRMED',
          subtext: 'SHIELD ABSORPTION 100%',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 65,
          alpha: 1.3,
          color: '#00ff9d'
        });
      } else if (ev.type === 'collision_damage') {
        this.shakeIntensity = 18;
        this.spawnExplosionSparks(this.smoothMechaX, this.smoothMechaY, '#ff4d00', 55, true);
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 20,
          maxRadius: 190,
          alpha: 1.0,
          color: '#ff2a54'
        });
        this.callouts.push({
          text: 'WARNING // HULL BREACH',
          subtext: '-35% INTEGRITY // VELOCITY DROP',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 70,
          alpha: 1.4,
          color: '#ff2a54'
        });
      } else if (ev.type === 'overdrive_activated') {
        this.shakeIntensity = 11;
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 20,
          maxRadius: 240,
          alpha: 1.0,
          color: '#ffb703'
        });
        this.callouts.push({
          text: 'AFTERBURNER OVERDRIVE',
          subtext: '2.0X SCORE MULTIPLIER ENGAGED',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 80,
          alpha: 1.5,
          color: '#ffb703'
        });
      } else if (ev.type === 'repair_collected') {
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 20,
          maxRadius: 170,
          alpha: 1.0,
          color: '#00ff9d'
        });
        this.callouts.push({
          text: 'REPARACIÓN',
          subtext: '+25% INTEGRIDAD',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 75,
          alpha: 1.4,
          color: '#00ff9d'
        });
      }
    }
  }

  private spawnExplosionSparks(
    x: number,
    y: number,
    color: string,
    count: number,
    includeSmoke = false
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 90 + Math.random() * 360;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        alpha: 1.0,
        size: 2.5 + Math.random() * 4.5,
        color
      });
    }
    if (includeSmoke) {
      for (let i = 0; i < 14; i++) {
        const angle = Math.random() * Math.PI * 2;
        const spd = 30 + Math.random() * 95;
        this.sparks.push({
          x,
          y,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd + 80,
          alpha: 0.65,
          size: 16 + Math.random() * 22,
          color: 'rgba(30, 38, 48, 0.7)',
          isSmoke: true
        });
      }
    }
  }

  private drawRealisticHighway(isOverdrive: boolean, role: PlayerRole): void {
    const { ctx } = this;
    const { WORLD_WIDTH, WORLD_HEIGHT, ROAD_LEFT, ROAD_RIGHT, ROAD_WIDTH, LANE_WIDTH } =
      TRACK_CONFIG;

    ctx.fillStyle = '#03060a';
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    if (this.roadTextureLoaded && this.roadTextureImg) {
      // Draw seamless scrolling realistic wet asphalt texture
      const y1 = Math.floor(this.roadScrollY);
      const y2 = y1 - WORLD_HEIGHT;
      ctx.save();
      ctx.globalAlpha = role === 'navigator' ? 0.55 : 0.88;
      ctx.drawImage(this.roadTextureImg, ROAD_LEFT - 35, y1, ROAD_WIDTH + 70, WORLD_HEIGHT);
      ctx.drawImage(this.roadTextureImg, ROAD_LEFT - 35, y2, ROAD_WIDTH + 70, WORLD_HEIGHT);
      ctx.restore();

      // Dark military color grade overlay
      const tint = ctx.createLinearGradient(ROAD_LEFT, 0, ROAD_RIGHT, 0);
      tint.addColorStop(0, 'rgba(3, 8, 15, 0.68)');
      tint.addColorStop(0.5, isOverdrive ? 'rgba(35, 12, 28, 0.35)' : 'rgba(4, 14, 24, 0.32)');
      tint.addColorStop(1, 'rgba(3, 8, 15, 0.68)');
      ctx.fillStyle = tint;
      ctx.fillRect(ROAD_LEFT - 35, 0, ROAD_WIDTH + 70, WORLD_HEIGHT);
    } else {
      const roadGrad = ctx.createLinearGradient(ROAD_LEFT, 0, ROAD_RIGHT, 0);
      roadGrad.addColorStop(0, '#070d16');
      roadGrad.addColorStop(0.5, '#0f1b29');
      roadGrad.addColorStop(1, '#070d16');
      ctx.fillStyle = roadGrad;
      ctx.fillRect(ROAD_LEFT, 0, ROAD_WIDTH, WORLD_HEIGHT);
    }

    // Crisp Mil-Spec Tactical Lane Dividers
    ctx.save();
    ctx.setLineDash([34, 26]);
    ctx.lineDashOffset = -this.roadScrollY;
    ctx.strokeStyle =
      role === 'navigator' ? 'rgba(0, 255, 128, 0.38)' : 'rgba(180, 225, 255, 0.24)';
    ctx.lineWidth = 2;

    for (let i = 1; i < 3; i++) {
      const laneX = ROAD_LEFT + i * LANE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(laneX, 0);
      ctx.lineTo(laneX, WORLD_HEIGHT);
      ctx.stroke();
    }
    ctx.restore();

    // Armored Bridge Side Rails
    ctx.strokeStyle = isOverdrive ? '#ffb703' : 'rgba(0, 240, 255, 0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ROAD_LEFT, 0);
    ctx.lineTo(ROAD_LEFT, WORLD_HEIGHT);
    ctx.moveTo(ROAD_RIGHT, 0);
    ctx.lineTo(ROAD_RIGHT, WORLD_HEIGHT);
    ctx.stroke();
  }

  private drawAfterburnersAndParticles(
    cosmetics: CosmeticLoadout,
    speed: number,
    isOverdrive: boolean,
    dt: number
  ): void {
    const { ctx } = this;
    const trailColor = TRAIL_COLORS[cosmetics.neonTrail];
    const tint = PAINT_TINTS[cosmetics.paintJob];

    // Spawn twin nozzle jet exhaust particles
    const nozzleOffsets = [-14, 14];
    for (const nx of nozzleOffsets) {
      this.sparks.push({
        x: this.smoothMechaX + nx + (Math.random() - 0.5) * 6,
        y: this.smoothMechaY + TRACK_CONFIG.MECHA_HEIGHT * 0.44,
        vx: (Math.random() - 0.5) * 28,
        vy: 190 + speed * 1.65,
        alpha: 0.85,
        size: 3.5 + Math.random() * 4.5,
        color: isOverdrive ? '#ffb703' : trailColor
      });
    }

    // Wet Asphalt Specular Reflection Pool under the Mecha
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const reflGrad = ctx.createRadialGradient(
      this.smoothMechaX,
      this.smoothMechaY + 28,
      4,
      this.smoothMechaX,
      this.smoothMechaY + 28,
      78
    );
    reflGrad.addColorStop(0, tint.glow);
    reflGrad.addColorStop(0.5, 'rgba(0, 240, 255, 0.14)');
    reflGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = reflGrad;
    ctx.fillRect(this.smoothMechaX - 85, this.smoothMechaY - 50, 170, 160);

    // Twin Jet Afterburner Flame Cones
    const flameLen = 28 + (speed / 250) * 48 + Math.random() * 12;
    for (const nx of nozzleOffsets) {
      const fx = this.smoothMechaX + nx;
      const fy = this.smoothMechaY + TRACK_CONFIG.MECHA_HEIGHT * 0.42;

      const flameGrad = ctx.createLinearGradient(fx, fy, fx, fy + flameLen);
      flameGrad.addColorStop(0, '#ffffff');
      flameGrad.addColorStop(0.35, trailColor);
      flameGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = flameGrad;
      ctx.beginPath();
      ctx.moveTo(fx - 6, fy);
      ctx.lineTo(fx + 6, fy);
      ctx.lineTo(fx, fy + flameLen);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Update & Draw all Sparks / Exhaust / Smoke particles
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.alpha -= (p.isSmoke ? 1.1 : 2.6) * dt;
      if (p.isSmoke) {
        p.size += 18 * dt;
      }

      if (p.alpha <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
      if (p.isSmoke) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
        ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size * 2.1);
      }
      ctx.restore();
    }
  }

  private drawRealisticObstacles(state: ServerWorldStatePayload, role: PlayerRole): void {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.015);

    for (const obs of state.entity_positions.obstacles) {
      ctx.save();
      const halfW = obs.width * 0.5;
      const halfH = obs.height * 0.5;

      if (obs.type === 'barrier') {
        // Wet road red warning reflection pool
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createRadialGradient(obs.x, obs.y, 4, obs.x, obs.y, 65);
        glow.addColorStop(0, `rgba(255, 35, 65, ${0.38 * pulse})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(obs.x - 70, obs.y - 70, 140, 140);
        ctx.restore();

        // Heavy Armored Titanium Barricade
        const metalGrad = ctx.createLinearGradient(obs.x - halfW, obs.y - halfH, obs.x - halfW, obs.y + halfH);
        metalGrad.addColorStop(0, '#3a4756');
        metalGrad.addColorStop(0.5, '#19212b');
        metalGrad.addColorStop(1, '#0b0f14');
        ctx.fillStyle = metalGrad;
        ctx.strokeStyle = '#ff2a54';
        ctx.lineWidth = 2;
        ctx.fillRect(obs.x - halfW, obs.y - halfH, obs.width, obs.height);
        ctx.strokeRect(obs.x - halfW, obs.y - halfH, obs.width, obs.height);

        // Diagonal warning hazard chevrons
        ctx.fillStyle = '#ffb703';
        for (let sx = -halfW + 8; sx < halfW - 12; sx += 18) {
          ctx.fillRect(obs.x + sx, obs.y - 4, 10, 8);
        }

        // Dual Strobe Lights
        ctx.fillStyle = pulse > 0.5 ? '#ff2a54' : '#ffffff';
        ctx.beginPath();
        ctx.arc(obs.x - halfW + 10, obs.y - halfH + 6, 4, 0, Math.PI * 2);
        ctx.arc(obs.x + halfW - 10, obs.y - halfH + 6, 4, 0, Math.PI * 2);
        ctx.fill();
      } else if (obs.type === 'flank_left' || obs.type === 'flank_right') {
        const isLeft = obs.type === 'flank_left';
        const targetFlankX = this.smoothMechaX + (isLeft ? -44 : 44);
        const angle = Math.atan2(this.smoothMechaY - obs.y, targetFlankX - obs.x);

        // Laser Lock-On Guidance Beam to Mecha Flank
        ctx.save();
        ctx.strokeStyle = role === 'navigator' ? 'rgba(255, 60, 0, 0.7)' : 'rgba(255, 35, 65, 0.38)';
        ctx.lineWidth = role === 'navigator' ? 2 : 1.2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(obs.x, obs.y);
        ctx.lineTo(targetFlankX, this.smoothMechaY);
        ctx.stroke();
        ctx.restore();

        // Hypersonic Cruise Missile Body oriented along velocity vector
        ctx.save();
        ctx.translate(obs.x, obs.y);
        ctx.rotate(angle);

        // Missile thruster plume
        ctx.fillStyle = '#ff7b00';
        ctx.beginPath();
        ctx.moveTo(-24, 0);
        ctx.lineTo(-10, -5);
        ctx.lineTo(-10, 5);
        ctx.closePath();
        ctx.fill();

        // Missile fuselage
        ctx.fillStyle = '#d8e2ec';
        ctx.strokeStyle = '#ff2a54';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(16, 0);
        ctx.lineTo(-10, -7);
        ctx.lineTo(-7, 0);
        ctx.lineTo(-10, 7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else if (obs.type === 'overdrive_cell' || obs.type === 'repair_cell') {
        const isOverdrive = obs.type === 'overdrive_cell';
        const coreColor = isOverdrive ? '#00f0ff' : '#00ff9d';

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const aura = ctx.createRadialGradient(obs.x, obs.y, 2, obs.x, obs.y, 34);
        aura.addColorStop(0, '#ffffff');
        aura.addColorStop(0.4, coreColor);
        aura.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(obs.x, obs.y, 34, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Rotating Octagonal Containment Ring
        ctx.strokeStyle = coreColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(obs.x - 14, obs.y - 14, 28, 28);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(isOverdrive ? 'MACH 2X' : 'REPAIR', obs.x, obs.y + 3);
      }

      // Stealth Fighter [TGT-LOCK] Reticle Box (Always clear in Navigator Radar, nearby in Driver)
      const distMeters = Math.max(0, Math.round((this.smoothMechaY - obs.y) * 0.5));
      if (role === 'navigator' || distMeters < 105) {
        this.drawTargetLockBox(obs.x, obs.y, obs.width + 14, obs.height + 14, obs.type, distMeters);
      }

      ctx.restore();
    }
  }

  private drawTargetLockBox(
    cx: number,
    cy: number,
    w: number,
    h: number,
    type: string,
    distMeters: number
  ): void {
    const { ctx } = this;
    const x = cx - w * 0.5;
    const y = cy - h * 0.5;
    const corner = 7;

    const isFriendly = type === 'overdrive_cell' || type === 'repair_cell';
    const color = isFriendly ? '#00ff9d' : type === 'barrier' ? '#ff2a54' : '#ffb703';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    // 4 Corner Brackets
    ctx.beginPath();
    ctx.moveTo(x, y + corner);
    ctx.lineTo(x, y);
    ctx.lineTo(x + corner, y);

    ctx.moveTo(x + w - corner, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + corner);

    ctx.moveTo(x, y + h - corner);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + corner, y + h);

    ctx.moveTo(x + w - corner, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - corner);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    const tag =
      type === 'flank_left'
        ? 'BOGEY-L [J]'
        : type === 'flank_right'
        ? 'BOGEY-R [L]'
        : type === 'barrier'
        ? `WALL ${distMeters}M`
        : 'CORE';
    ctx.fillText(tag, x, y - 4);
    ctx.restore();
  }

  private drawRealisticMechaAndShields(
    state: ServerWorldStatePayload,
    cosmetics: CosmeticLoadout
  ): void {
    const { ctx } = this;
    const x = this.smoothMechaX;
    const y = this.smoothMechaY;
    const w = TRACK_CONFIG.MECHA_WIDTH;
    const h = TRACK_CONFIG.MECHA_HEIGHT;
    const tint = PAINT_TINTS[cosmetics.paintJob];

    ctx.save();

    // Active Left & Right Hexagonal Plasma Flank Shields
    if (state.world_state.active_shields.left) {
      this.drawFlankEnergyShield(x - TRACK_CONFIG.SHIELD_OFFSET_X, y, -1);
    }
    if (state.world_state.active_shields.right) {
      this.drawFlankEnergyShield(x + TRACK_CONFIG.SHIELD_OFFSET_X, y, 1);
    }

    // Draw Stealth Mecha-Interceptor with aerodynamic banking rotation
    ctx.translate(x, y);
    ctx.rotate(this.smoothBankAngle);

    if (this.mechaCutoutCanvas) {
      const drawW = w * 1.48;
      const drawH = h * 1.38;
      ctx.shadowColor = tint.primary;
      ctx.shadowBlur = state.world_state.is_overdrive ? 24 : 12;
      ctx.drawImage(this.mechaCutoutCanvas, -drawW * 0.5, -drawH * 0.5, drawW, drawH);

      // Subtle cosmetic armor rim light
      ctx.strokeStyle = tint.primary;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.52);
      ctx.lineTo(w * 0.48, h * 0.38);
      ctx.moveTo(0, -h * 0.52);
      ctx.lineTo(-w * 0.48, h * 0.38);
      ctx.stroke();
    } else {
      // Fallback high-detail stealth fighter silhouette while image loads
      ctx.fillStyle = '#121a24';
      ctx.strokeStyle = tint.primary;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.55);
      ctx.lineTo(w * 0.55, h * 0.25);
      ctx.lineTo(w * 0.25, h * 0.5);
      ctx.lineTo(-w * 0.25, h * 0.5);
      ctx.lineTo(-w * 0.55, h * 0.25);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawFlankEnergyShield(sx: number, sy: number, dir: -1 | 1): void {
    const { ctx } = this;
    const halfH = TRACK_CONFIG.SHIELD_HALF_HEIGHT;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Outer plasma glow
    const grad = ctx.createLinearGradient(sx - 12 * dir, sy, sx + 16 * dir, sy);
    grad.addColorStop(0, 'rgba(0, 240, 255, 0)');
    grad.addColorStop(0.5, 'rgba(0, 240, 255, 0.65)');
    grad.addColorStop(1, 'rgba(0, 255, 157, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(sx - 14, sy - halfH, 28, halfH * 2);

    // Core energy arc matching Circle-to-Line geometry
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(sx, sy - halfH);
    ctx.lineTo(sx + 7 * dir, sy);
    ctx.lineTo(sx, sy + halfH);
    ctx.stroke();
    ctx.restore();
  }

  private updateAndDrawShockwaves(dt: number): void {
    const { ctx } = this;
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.radius += 420 * dt;
      sw.alpha -= 2.2 * dt;
      if (sw.alpha <= 0 || sw.radius >= sw.maxRadius) {
        this.shockwaves.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = sw.color;
      ctx.globalAlpha = Math.max(0, sw.alpha);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private updateAndDrawRain(speed: number, dt: number): void {
    const { ctx } = this;
    const { WORLD_WIDTH, WORLD_HEIGHT } = TRACK_CONFIG;

    ctx.save();
    ctx.strokeStyle = 'rgba(185, 225, 255, 0.25)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();

    for (const drop of this.rainDrops) {
      drop.y += (drop.speed + speed * 2.2) * dt;
      drop.x -= 45 * dt;
      if (drop.y > WORLD_HEIGHT) {
        drop.y = -30;
        drop.x = Math.random() * WORLD_WIDTH;
      }
      if (drop.x < 0) {
        drop.x = WORLD_WIDTH;
      }

      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x - 2, drop.y + drop.length);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Pilot A (Driver) Realistic Volumetric Headlight Cones & Fog of War.
   */
  private drawDriverVolumetricLighting(state: ServerWorldStatePayload): void {
    const { ctx } = this;
    const width = TRACK_CONFIG.WORLD_WIDTH;
    const height = TRACK_CONFIG.WORLD_HEIGHT;
    const visRadius = state.fog_matrix.visibility_radius;
    const isRadarRevealed = state.fog_matrix.radar_reveal_timer > 0;

    // 1. Add Dual Volumetric Headlight Beams in front of Mecha
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const coneLen = visRadius * 1.45;
    const headGrad = ctx.createLinearGradient(
      this.smoothMechaX,
      this.smoothMechaY - 20,
      this.smoothMechaX,
      this.smoothMechaY - coneLen
    );
    headGrad.addColorStop(0, 'rgba(200, 245, 255, 0.26)');
    headGrad.addColorStop(0.6, 'rgba(0, 210, 255, 0.08)');
    headGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.moveTo(this.smoothMechaX - 18, this.smoothMechaY - 28);
    ctx.lineTo(this.smoothMechaX - 135, this.smoothMechaY - coneLen);
    ctx.lineTo(this.smoothMechaX + 135, this.smoothMechaY - coneLen);
    ctx.lineTo(this.smoothMechaX + 18, this.smoothMechaY - 28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 2. Dynamic Radial Night-Storm Fog Mask
    ctx.save();
    const centerFocusY = this.smoothMechaY - 65;
    const fogGrad = ctx.createRadialGradient(
      this.smoothMechaX,
      centerFocusY,
      visRadius * 0.38,
      this.smoothMechaX,
      centerFocusY,
      visRadius * 1.08
    );

    fogGrad.addColorStop(0, 'rgba(2, 5, 10, 0.0)');
    fogGrad.addColorStop(0.68, 'rgba(2, 6, 12, 0.82)');
    fogGrad.addColorStop(1, 'rgba(1, 3, 7, 0.985)');

    ctx.fillStyle = fogGrad;
    ctx.fillRect(0, 0, width, height);

    // If Navigator triggered Radar Pulse, overlay FLIR Thermal Green Night-Vision scan
    if (isRadarRevealed) {
      ctx.fillStyle = 'rgba(0, 255, 120, 0.07)';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
  }

  /**
   * Pilot B (Navigator) Overhead AWACS / F-35 Tactical Radar Scan.
   */
  private drawNavigatorStealthRadar(state: ServerWorldStatePayload): void {
    const { ctx } = this;
    const { ROAD_LEFT, ROAD_WIDTH, LANE_WIDTH, WORLD_HEIGHT } = TRACK_CONFIG;

    ctx.save();
    // Phosphor green tactical grid lines
    ctx.strokeStyle = 'rgba(0, 255, 128, 0.08)';
    ctx.lineWidth = 1;
    for (let y = 0; y < WORLD_HEIGHT; y += 60) {
      ctx.beginPath();
      ctx.moveTo(ROAD_LEFT, y);
      ctx.lineTo(ROAD_LEFT + ROAD_WIDTH, y);
      ctx.stroke();
    }

    // Sweeping AWACS Radar Scanline
    const scanGrad = ctx.createLinearGradient(0, this.radarSweepY - 48, 0, this.radarSweepY);
    scanGrad.addColorStop(0, 'rgba(0, 255, 157, 0)');
    scanGrad.addColorStop(1, 'rgba(0, 255, 157, 0.22)');
    ctx.fillStyle = scanGrad;
    ctx.fillRect(ROAD_LEFT, this.radarSweepY - 48, ROAD_WIDTH, 48);

    // Clickable Tactical Sector Headers
    ctx.fillStyle = 'rgba(0, 255, 157, 0.85)';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    for (let lane = 0; lane < 3; lane++) {
      const cx = ROAD_LEFT + lane * LANE_WIDTH + LANE_WIDTH * 0.5;
      ctx.fillText(`[SECTOR 0${lane + 1} // TAP TO PING]`, cx, 108);
    }
    ctx.restore();
  }

  /**
   * Renders Stealth Fighter HUD instrumentation (Compass Tape, Pitch Ladder, Mach & G-Force).
   */
  private drawStealthFighterCockpitHUD(
    state: ServerWorldStatePayload,
    role: PlayerRole
  ): void {
    const { ctx } = this;
    const width = TRACK_CONFIG.WORLD_WIDTH;
    const speed = state.speed_multiplier.current_speed;
    const mach = (speed / 100).toFixed(2);
    const gForce = (1.0 + (speed / 250) * 3.8 + Math.abs(this.smoothBankAngle) * 4).toFixed(1);
    const hudColor = role === 'navigator' ? '#00ff9d' : '#ffb703';

    ctx.save();
    ctx.strokeStyle = hudColor;
    ctx.fillStyle = hudColor;
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1.2;

    // Top Compass Tape (HDG)
    const tapeY = 76;
    ctx.beginPath();
    ctx.moveTo(150, tapeY);
    ctx.lineTo(width - 150, tapeY);
    ctx.stroke();

    const headingOffset = Math.floor(this.smoothMechaX * 0.25) % 30;
    for (let x = 165; x <= width - 165; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x - headingOffset, tapeY);
      ctx.lineTo(x - headingOffset, tapeY + 5);
      ctx.stroke();
    }

    // Left & Right Flight Telemetry Readouts
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`AIRSPEED: MACH ${mach}`, 22, 460);
    ctx.fillText(`LOAD: ${gForce} G`, 22, 476);
    ctx.fillText(`ALT: 00420 FT AGL`, 22, 492);

    ctx.textAlign = 'right';
    ctx.fillText(
      `SHIELD L: ${state.world_state.active_shields.left ? 'ENGAGED' : 'STBY'}`,
      width - 22,
      460
    );
    ctx.fillText(
      `SHIELD R: ${state.world_state.active_shields.right ? 'ENGAGED' : 'STBY'}`,
      width - 22,
      476
    );
    ctx.fillText(
      `VIS-MODE: ${role === 'driver' ? 'LOW-VIS CONE' : 'AWACS OVERHEAD'}`,
      width - 22,
      492
    );

    // Subtle Pitch Ladder bars around Mecha
    const px = this.smoothMechaX;
    const py = this.smoothMechaY;
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    ctx.moveTo(px - 68, py - 20);
    ctx.lineTo(px - 50, py - 20);
    ctx.lineTo(px - 50, py - 14);
    ctx.moveTo(px + 68, py - 20);
    ctx.lineTo(px + 50, py - 20);
    ctx.lineTo(px + 50, py - 14);
    ctx.stroke();

    ctx.restore();
  }

  private drawTacticalPings(state: ServerWorldStatePayload): void {
    const { ctx } = this;

    for (const ping of state.world_state.active_pings) {
      const alpha = Math.min(1, ping.ttl / 0.6);
      const laneX = getLaneCenterX(ping.lane);
      const targetY = Math.min(ping.y_offset, this.smoothMechaY - 175);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#00ff9d';
      ctx.fillStyle = 'rgba(0, 255, 157, 0.13)';
      ctx.lineWidth = 2;

      const boxW = TRACK_CONFIG.LANE_WIDTH * 0.82;
      ctx.fillRect(laneX - boxW * 0.5, targetY - 55, boxW, 195);
      ctx.strokeRect(laneX - boxW * 0.5, targetY - 55, boxW, 195);

      // Guidance vector line from Mecha nose to Ping corridor
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(this.smoothMechaX, this.smoothMechaY - 42);
      ctx.lineTo(laneX, targetY + 35);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#00ff9d';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`VECTOR SAFE // SECTOR 0${ping.lane + 1}`, laneX, targetY - 22);
      ctx.restore();
    }
  }

  private updateAndDrawCallouts(dt: number): void {
    const { ctx } = this;
    for (let i = this.callouts.length - 1; i >= 0; i--) {
      const c = this.callouts[i];
      c.y -= 42 * dt;
      c.alpha -= 1.05 * dt;
      if (c.alpha <= 0) {
        this.callouts.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.min(1, c.alpha);
      ctx.fillStyle = 'rgba(4, 9, 18, 0.85)';
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.5;
      ctx.fillRect(c.x - 115, c.y - 22, 230, 36);
      ctx.strokeRect(c.x - 115, c.y - 22, 230, 36);

      ctx.fillStyle = c.color;
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(c.text, c.x, c.y - 5);

      ctx.fillStyle = '#d8e9ff';
      ctx.font = '10px monospace';
      ctx.fillText(c.subtext, c.x, c.y + 9);
      ctx.restore();
    }
  }

  /**
   * Renders Live Holographic Radio Comms Banner inside the 9:16 Canvas
   * so TikTok / Reels video recordings capture live Pilot-to-Pilot reactions.
   */
  private updateAndDrawCommsBanner(dt: number): void {
    if (!this.activeCommsBanner) return;
    this.activeCommsBanner.ttl -= dt;
    if (this.activeCommsBanner.ttl <= 0) {
      this.activeCommsBanner = null;
      return;
    }

    const { ctx } = this;
    const { event, ttl } = this.activeCommsBanner;
    const alpha = Math.min(1, ttl / 0.4);
    const boxX = 75;
    const boxY = 122;
    const boxW = TRACK_CONFIG.WORLD_WIDTH - 150;
    const boxH = 54;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(4, 12, 22, 0.92)';
    ctx.strokeStyle = event.preset === 'mayday_panic' ? '#ff2a54' : '#00ff9d';
    ctx.lineWidth = 2;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    // Animated Voice Oscilloscope Bars
    ctx.fillStyle = ctx.strokeStyle;
    for (let i = 0; i < 8; i++) {
      const barH = 6 + Math.abs(Math.sin(Date.now() * 0.02 + i)) * 24;
      ctx.fillRect(boxX + 14 + i * 6, boxY + 27 - barH * 0.5, 4, barH);
    }

    ctx.textAlign = 'left';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(
      `COMMS // ${event.sender_name} (${event.sender_role.toUpperCase()}) — ${event.code}`,
      boxX + 72,
      boxY + 20
    );

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(event.label, boxX + 72, boxY + 40);
    ctx.restore();
  }

  private drawCriticalSpeedWarning(countdown: number): void {
    const { ctx } = this;
    const pulse = 0.35 + Math.abs(Math.sin(Date.now() * 0.014)) * 0.55;

    ctx.save();
    ctx.strokeStyle = `rgba(255, 30, 60, ${pulse})`;
    ctx.lineWidth = 12;
    ctx.strokeRect(0, 0, TRACK_CONFIG.WORLD_WIDTH, TRACK_CONFIG.WORLD_HEIGHT);

    ctx.fillStyle = 'rgba(18, 3, 8, 0.9)';
    ctx.strokeStyle = '#ff2a54';
    ctx.lineWidth = 2;
    ctx.fillRect(95, 190, TRACK_CONFIG.WORLD_WIDTH - 190, 56);
    ctx.strokeRect(95, 190, TRACK_CONFIG.WORLD_WIDTH - 190, 56);

    ctx.fillStyle = '#ff2a54';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      `MASTER CAUTION // STALL SPEED (<50)`,
      TRACK_CONFIG.WORLD_WIDTH * 0.5,
      214
    );
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(
      `AUTODESTRUCT SEQUENCE: ${countdown.toFixed(2)}S`,
      TRACK_CONFIG.WORLD_WIDTH * 0.5,
      236
    );
    ctx.restore();
  }
}
