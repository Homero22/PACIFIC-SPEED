import { getClosestLane, getLaneCenterX, lerp, TRACK_CONFIG } from '../shared/math.js';
import {
  animalsBetween,
  RESCUE_EVERY_METERS,
  rescuedCount,
  weatherForPhase,
  type AnimalKind,
  type WeatherLook
} from './rescueTheme.js';
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
  // Internal ids are kept (saved in localStorage / sent to the server); only the look changes.
  crimson_jaeger: { primary: '#e63946', glow: 'rgba(230, 57, 70, 0.5)', afterburner: '#ff8a5b' }, // Rojo rescate
  cyber_gold: { primary: '#f4a261', glow: 'rgba(244, 162, 97, 0.5)', afterburner: '#ffd166' }, // Dorado huellita
  phantom_stealth: { primary: '#2a9d8f', glow: 'rgba(42, 157, 143, 0.5)', afterburner: '#7ee8d8' } // Verde refugio
};

const TRAIL_COLORS: Record<CosmeticLoadout['neonTrail'], string> = {
  plasma_cyan: '#7ee8d8', // Turquesa
  overdrive_magenta: '#ff8fab', // Rosa
  solar_flare: '#ffb347' // Naranja
};

/** Left x for a label of `width` px starting at `x`, kept within [4, canvasWidth - 4]. */
function clampLabelX(x: number, width: number, canvasWidth: number): number {
  return Math.max(4, Math.min(x, canvasWidth - 4 - width));
}

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

  // Rescue theme state (presentation only)
  private lastRescued = 0;
  private lightningFlash = 0;
  private hearts: Array<{ x: number; y: number; vy: number; alpha: number }> = [];

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

  }

  public showCommsBanner(event: TacticalCommsEvent): void {
    this.activeCommsBanner = {
      event,
      ttl: 2.2
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

    // Weather follows the difficulty phase (sunset → rain → storm → night → dawn)
    const weather = weatherForPhase(state.world_state.difficulty_phase);

    // 1. Coastal road at night with roadside verges and lamps
    this.drawRealisticHighway(state.world_state.is_overdrive, activeRole, weather);

    // 2. Wet road reflections and the rescue vehicle's light trails
    this.drawAfterburnersAndParticles(cosmetics, speed, state.world_state.is_overdrive, dt);

    // 3. Storm debris: fallen logs, wind-blown branches, golden bones and vet kits
    this.drawRealisticObstacles(state, activeRole);

    // 4. Rescue vehicle and paw-shaped protective shields
    this.drawRealisticMechaAndShields(state, cosmetics);

    // 5. Render Shockwave Rings & Physical Spark Debris
    this.updateAndDrawShockwaves(dt);

    // 6. Weather: color grade, rain, lightning and the dawn rainbow
    this.drawWeather(weather, speed, dt);

    // 7. Asymmetric Tactical Role Layer:
    // Driver gets Volumetric Headlight Cones + Night-Vision FLIR on Radar Pulse;
    // Navigator gets Full Overhead Stealth Fighter Radar HUD
    if (activeRole === 'driver') {
      this.drawDriverVolumetricLighting(state);
    } else {
      this.drawNavigatorStealthRadar(state);
    }

    // 7b. Animals waiting on the roadside (drawn over the fog: their lamps light them up)
    this.drawRoadsideAnimals(state, weather, dt);

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
        this.shakeIntensity = 7;
        this.spawnExplosionSparks(this.smoothMechaX, this.smoothMechaY - 10, '#7ee8d8', 30);
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 25,
          maxRadius: 150,
          alpha: 1.0,
          color: '#2ec4b6'
        });
        this.callouts.push({
          text: '¡BIEN BLOQUEADO!',
          subtext: 'El escudo protegió la carga',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 65,
          alpha: 1.3,
          color: '#2ec4b6'
        });
      } else if (ev.type === 'collision_damage') {
        this.shakeIntensity = 16;
        this.spawnExplosionSparks(this.smoothMechaX, this.smoothMechaY, '#ffb067', 40, true);
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 20,
          maxRadius: 190,
          alpha: 1.0,
          color: '#ff5a5f'
        });
        this.callouts.push({
          text: '¡GOLPE!',
          subtext: '-35% salud del vehículo · pierdes velocidad',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 70,
          alpha: 1.4,
          color: '#ff5a5f'
        });
      } else if (ev.type === 'overdrive_activated') {
        this.shakeIntensity = 9;
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 20,
          maxRadius: 240,
          alpha: 1.0,
          color: '#ffc94d'
        });
        this.callouts.push({
          text: '¡TURBO CROQUETA!',
          subtext: 'Puntos dobles mientras dure',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 80,
          alpha: 1.5,
          color: '#ffc94d'
        });
      } else if (ev.type === 'repair_collected') {
        this.shockwaves.push({
          x: this.smoothMechaX,
          y: this.smoothMechaY,
          radius: 20,
          maxRadius: 170,
          alpha: 1.0,
          color: '#7bd88f'
        });
        this.callouts.push({
          text: 'BOTIQUÍN',
          subtext: '+25% salud del vehículo',
          x: this.smoothMechaX,
          y: this.smoothMechaY - 75,
          alpha: 1.4,
          color: '#7bd88f'
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

  private drawRealisticHighway(isOverdrive: boolean, role: PlayerRole, weather: WeatherLook): void {
    const { ctx } = this;
    const { WORLD_WIDTH, WORLD_HEIGHT, ROAD_LEFT, ROAD_RIGHT, ROAD_WIDTH, LANE_WIDTH } =
      TRACK_CONFIG;

    // Roadside verges: wet grass on the left, sand towards the Pacific on the right
    ctx.fillStyle = '#0b1410';
    ctx.fillRect(0, 0, ROAD_LEFT, WORLD_HEIGHT);
    ctx.fillStyle = '#14120e';
    ctx.fillRect(ROAD_RIGHT, 0, WORLD_WIDTH - ROAD_RIGHT, WORLD_HEIGHT);

    // Bushes and sand ripples scroll with the road so the verges feel alive
    ctx.save();
    for (let i = 0; i < 12; i++) {
      const y = ((i * 97 + this.roadScrollY) % (WORLD_HEIGHT + 60)) - 30;
      ctx.fillStyle = 'rgba(40, 80, 50, 0.55)';
      ctx.beginPath();
      ctx.ellipse(18 + ((i * 37) % 40), y, 14, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120, 100, 70, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ROAD_RIGHT + 14, y + 20);
      ctx.quadraticCurveTo(ROAD_RIGHT + 45, y + 10, ROAD_RIGHT + 80, y + 22);
      ctx.stroke();
    }
    ctx.restore();

    if (this.roadTextureLoaded && this.roadTextureImg) {
      // Scrolling wet asphalt texture
      const y1 = Math.floor(this.roadScrollY);
      const y2 = y1 - WORLD_HEIGHT;
      ctx.save();
      ctx.globalAlpha = role === 'navigator' ? 0.55 : 0.85;
      ctx.drawImage(this.roadTextureImg, ROAD_LEFT, y1, ROAD_WIDTH, WORLD_HEIGHT);
      ctx.drawImage(this.roadTextureImg, ROAD_LEFT, y2, ROAD_WIDTH, WORLD_HEIGHT);
      ctx.restore();

      // Warm evening grade instead of the old military blue
      const tint = ctx.createLinearGradient(ROAD_LEFT, 0, ROAD_RIGHT, 0);
      tint.addColorStop(0, 'rgba(12, 10, 14, 0.62)');
      tint.addColorStop(0.5, isOverdrive ? 'rgba(60, 40, 10, 0.3)' : 'rgba(20, 18, 24, 0.28)');
      tint.addColorStop(1, 'rgba(12, 10, 14, 0.62)');
      ctx.fillStyle = tint;
      ctx.fillRect(ROAD_LEFT, 0, ROAD_WIDTH, WORLD_HEIGHT);
    } else {
      const roadGrad = ctx.createLinearGradient(ROAD_LEFT, 0, ROAD_RIGHT, 0);
      roadGrad.addColorStop(0, '#121216');
      roadGrad.addColorStop(0.5, '#1c1c22');
      roadGrad.addColorStop(1, '#121216');
      ctx.fillStyle = roadGrad;
      ctx.fillRect(ROAD_LEFT, 0, ROAD_WIDTH, WORLD_HEIGHT);
    }

    // Lane dividers (painted road markings)
    ctx.save();
    ctx.setLineDash([34, 26]);
    ctx.lineDashOffset = -this.roadScrollY;
    ctx.strokeStyle = role === 'navigator' ? 'rgba(46, 196, 182, 0.45)' : 'rgba(255, 236, 200, 0.32)';
    ctx.lineWidth = 3;
    for (let i = 1; i < 3; i++) {
      const laneX = ROAD_LEFT + i * LANE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(laneX, 0);
      ctx.lineTo(laneX, WORLD_HEIGHT);
      ctx.stroke();
    }
    ctx.restore();

    // Road edges and guardrails
    ctx.strokeStyle = isOverdrive ? '#ffc94d' : 'rgba(255, 214, 160, 0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ROAD_LEFT, 0);
    ctx.lineTo(ROAD_LEFT, WORLD_HEIGHT);
    ctx.moveTo(ROAD_RIGHT, 0);
    ctx.lineTo(ROAD_RIGHT, WORLD_HEIGHT);
    ctx.stroke();

    // Street lamps along both verges with warm pools of light
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const y = ((i * 170 + this.roadScrollY * 0.9) % (WORLD_HEIGHT + 120)) - 60;
      for (const x of [ROAD_LEFT - 18, ROAD_RIGHT + 18]) {
        const pool = ctx.createRadialGradient(x, y, 2, x, y, 70);
        pool.addColorStop(0, weather.lampColor);
        pool.addColorStop(0.15, 'rgba(255, 190, 110, 0.18)');
        pool.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = pool;
        ctx.fillRect(x - 70, y - 70, 140, 140);
      }
    }
    ctx.restore();
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

    // Water spray from the rear wheels (turbo turns it golden)
    for (const nx of [-20, 20]) {
      this.sparks.push({
        x: this.smoothMechaX + nx + (Math.random() - 0.5) * 6,
        y: this.smoothMechaY + TRACK_CONFIG.MECHA_HEIGHT * 0.44,
        vx: (Math.random() - 0.5) * 40,
        vy: 160 + speed * 1.5,
        alpha: 0.6,
        size: 2.5 + Math.random() * 3.5,
        color: isOverdrive ? '#ffc94d' : trailColor
      });
    }

    // Reflection of the vehicle's lights on the wet road
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
    reflGrad.addColorStop(0.5, 'rgba(255, 180, 110, 0.10)');
    reflGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = reflGrad;
    ctx.fillRect(this.smoothMechaX - 85, this.smoothMechaY - 50, 170, 160);

    // Taillight streaks: longer the faster the patrol goes
    const streakLen = 18 + (speed / 250) * 46;
    for (const nx of [-17, 17]) {
      const fx = this.smoothMechaX + nx;
      const fy = this.smoothMechaY + TRACK_CONFIG.MECHA_HEIGHT * 0.46;
      const streak = ctx.createLinearGradient(fx, fy, fx, fy + streakLen);
      streak.addColorStop(0, isOverdrive ? '#ffe08a' : '#ff5a5f');
      streak.addColorStop(0.4, isOverdrive ? 'rgba(255, 201, 77, 0.5)' : 'rgba(255, 90, 95, 0.35)');
      streak.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = streak;
      ctx.fillRect(fx - 3.5, fy, 7, streakLen);
    }
    ctx.restore();

    // Update & draw spray / sparks / smoke particles
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
      ctx.fillStyle = p.color;
      ctx.beginPath();
      if (p.isSmoke) {
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      } else {
        ctx.globalCompositeOperation = 'lighter';
        ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    }
  }

  private drawRealisticObstacles(state: ServerWorldStatePayload, role: PlayerRole): void {
    const { ctx } = this;
    const now = Date.now();
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.012);

    for (const obs of state.entity_positions.obstacles) {
      ctx.save();
      const halfW = obs.width * 0.5;
      const halfH = obs.height * 0.5;

      if (obs.type === 'barrier') {
        // Warning glow on the wet road
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createRadialGradient(obs.x, obs.y, 4, obs.x, obs.y, 62);
        glow.addColorStop(0, `rgba(255, 120, 60, ${0.3 * pulse})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(obs.x - 66, obs.y - 66, 132, 132);
        ctx.restore();

        // Fallen tree trunk across the lane
        const bark = ctx.createLinearGradient(obs.x, obs.y - halfH, obs.x, obs.y + halfH);
        bark.addColorStop(0, '#8a5a34');
        bark.addColorStop(0.5, '#5e3b20');
        bark.addColorStop(1, '#3b2414');
        ctx.fillStyle = bark;
        this.roundedRect(obs.x - halfW + 6, obs.y - halfH + 5, obs.width - 12, obs.height - 10, 11);
        ctx.fill();
        ctx.strokeStyle = 'rgba(40, 22, 10, 0.8)';
        ctx.lineWidth = 1.5;
        for (let bx = -halfW + 18; bx < halfW - 16; bx += 14) {
          ctx.beginPath();
          ctx.moveTo(obs.x + bx, obs.y - 6);
          ctx.lineTo(obs.x + bx + 7, obs.y + 5);
          ctx.stroke();
        }
        // Cut ends with growth rings
        for (const ex of [obs.x - halfW + 8, obs.x + halfW - 8]) {
          ctx.fillStyle = '#d9a86c';
          ctx.beginPath();
          ctx.ellipse(ex, obs.y, 6, halfH - 5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#8a5a34';
          ctx.beginPath();
          ctx.ellipse(ex, obs.y, 3, (halfH - 5) * 0.5, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Small leafy twig so it reads as a tree
        ctx.fillStyle = '#3f7d4a';
        ctx.beginPath();
        ctx.ellipse(obs.x + 10, obs.y - halfH + 2, 10, 5, -0.4, 0, Math.PI * 2);
        ctx.ellipse(obs.x + 20, obs.y - halfH + 4, 7, 4, 0.3, 0, Math.PI * 2);
        ctx.fill();
        // Warning cones on both sides, blinking
        for (const cx of [obs.x - halfW - 2, obs.x + halfW + 2]) {
          ctx.fillStyle = '#ff8c2a';
          ctx.beginPath();
          ctx.moveTo(cx, obs.y - 12);
          ctx.lineTo(cx - 7, obs.y + 10);
          ctx.lineTo(cx + 7, obs.y + 10);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = pulse > 0.5 ? '#ffffff' : '#ffd9a8';
          ctx.fillRect(cx - 4, obs.y - 1, 8, 3);
        }
      } else if (obs.type === 'flank_cross') {
        // Crossing sign (flank_cross): its wind path runs down its edge, then across the whole road
        const fromLeft = obs.side_threat === 'left';
        const farEdge = fromLeft ? TRACK_CONFIG.ROAD_RIGHT + 30 : TRACK_CONFIG.ROAD_LEFT - 30;
        ctx.save();
        ctx.strokeStyle = role === 'navigator' ? 'rgba(255, 196, 90, 0.8)' : 'rgba(255, 196, 90, 0.4)';
        ctx.lineWidth = role === 'navigator' ? 2.2 : 1.4;
        ctx.setLineDash([4, 8]);
        ctx.lineDashOffset = -now * 0.06;
        ctx.beginPath();
        ctx.moveTo(obs.x, obs.y);
        if (!obs.crossing) ctx.lineTo(obs.x, this.smoothMechaY);
        ctx.lineTo(farEdge, this.smoothMechaY);
        ctx.stroke();
        ctx.restore();

        // A "watch for animals" road sign torn off by the wind, spinning (same hitbox as a branch)
        ctx.save();
        ctx.translate(obs.x, obs.y);
        ctx.rotate((now * (obs.crossing ? 0.012 : 0.006) * (fromLeft ? 1 : -1)) % (Math.PI * 2));
        // Warm glow so it reads at a glance in the storm
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const signGlow = ctx.createRadialGradient(0, 0, 4, 0, 0, 34);
        signGlow.addColorStop(0, 'rgba(255, 200, 40, 0.45)');
        signGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = signGlow;
        ctx.beginPath();
        ctx.arc(0, 0, 34, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // Snapped piece of the post
        ctx.fillStyle = '#8f969c';
        ctx.fillRect(-2.5, 14, 5, 12);
        // Yellow diamond with a black border
        const half = 19;
        ctx.beginPath();
        ctx.moveTo(0, -half);
        ctx.lineTo(half, 0);
        ctx.lineTo(0, half);
        ctx.lineTo(-half, 0);
        ctx.closePath();
        ctx.fillStyle = '#ffcc1a';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#1b1b1b';
        ctx.stroke();
        // Inner border line, like a real road sign
        ctx.beginPath();
        ctx.moveTo(0, -half + 4);
        ctx.lineTo(half - 4, 0);
        ctx.lineTo(0, half - 4);
        ctx.lineTo(-half + 4, 0);
        ctx.closePath();
        ctx.lineWidth = 1;
        ctx.stroke();
        // Paw print pictogram
        this.drawPaw(0, 1, 9, '#1b1b1b');
        ctx.restore();
      } else if (obs.type === 'flank_left' || obs.type === 'flank_right') {
        const isLeft = obs.type === 'flank_left';
        const targetFlankX = this.smoothMechaX + (isLeft ? -44 : 44);

        // Wind gust line showing where the branch is heading
        ctx.save();
        ctx.strokeStyle = role === 'navigator' ? 'rgba(255, 196, 90, 0.75)' : 'rgba(255, 196, 90, 0.35)';
        ctx.lineWidth = role === 'navigator' ? 2 : 1.2;
        ctx.setLineDash([4, 8]);
        ctx.lineDashOffset = -now * 0.05;
        ctx.beginPath();
        ctx.moveTo(obs.x, obs.y);
        ctx.quadraticCurveTo((obs.x + targetFlankX) / 2, obs.y - 30, targetFlankX, this.smoothMechaY);
        ctx.stroke();
        ctx.restore();

        // Spinning branch with leaves, blown in by the storm
        ctx.save();
        ctx.translate(obs.x, obs.y);
        ctx.rotate((now * 0.006 * (isLeft ? 1 : -1)) % (Math.PI * 2));
        ctx.strokeStyle = '#6b4426';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-18, 0);
        ctx.lineTo(18, 0);
        ctx.moveTo(4, 0);
        ctx.lineTo(12, -9);
        ctx.moveTo(-6, 0);
        ctx.lineTo(-12, 8);
        ctx.stroke();
        ctx.fillStyle = '#4f9a5a';
        const leaves: Array<[number, number]> = [[18, 0], [12, -10], [-12, 9], [-18, 0], [0, -4]];
        for (const [lx, ly] of leaves) {
          ctx.beginPath();
          ctx.ellipse(lx, ly, 6, 3.5, lx * 0.05, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      } else if (obs.type === 'overdrive_cell') {
        // Golden bone: "turbo croqueta"
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const aura = ctx.createRadialGradient(obs.x, obs.y, 2, obs.x, obs.y, 34);
        aura.addColorStop(0, 'rgba(255, 236, 160, 0.9)');
        aura.addColorStop(0.45, 'rgba(255, 201, 77, 0.45)');
        aura.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(obs.x, obs.y, 34, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(obs.x, obs.y);
        ctx.rotate(Math.sin(now * 0.004) * 0.35);
        ctx.fillStyle = '#ffd56b';
        ctx.strokeStyle = '#b8860b';
        ctx.lineWidth = 1.5;
        ctx.fillRect(-11, -4, 22, 8);
        for (const [bx, by] of [[-12, -5], [-12, 5], [12, -5], [12, 5]] as Array<[number, number]>) {
          ctx.beginPath();
          ctx.arc(bx, by, 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      } else if (obs.type === 'repair_cell') {
        // Vet first-aid kit
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const aura = ctx.createRadialGradient(obs.x, obs.y, 2, obs.x, obs.y, 32);
        aura.addColorStop(0, 'rgba(180, 255, 200, 0.7)');
        aura.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(obs.x, obs.y, 32, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = '#f8f8f4';
        this.roundedRect(obs.x - 14, obs.y - 11, 28, 22, 5);
        ctx.fill();
        ctx.fillStyle = '#5c4033';
        ctx.fillRect(obs.x - 5, obs.y - 15, 10, 4);
        ctx.fillStyle = '#3fbf6a';
        ctx.fillRect(obs.x - 2.5, obs.y - 8, 5, 16);
        ctx.fillRect(obs.x - 8, obs.y - 2.5, 16, 5);
      }

      // Labels: always on the navigator radar, only when close (~210 px, as before) for the driver
      const distMeters = Math.max(0, Math.round((this.smoothMechaY - obs.y) / 23.5));
      const ahead = obs.y < this.smoothMechaY + 20;
      if (ahead && (role === 'navigator' || this.smoothMechaY - obs.y < 210)) {
        this.drawTargetLockBox(obs.x, obs.y, obs.width + 14, obs.height + 14, obs.type, distMeters, obs.side_threat);
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
    distMeters: number,
    side?: 'left' | 'right'
  ): void {
    const { ctx } = this;
    const x = cx - w * 0.5;
    const y = cy - h * 0.5;
    const corner = 7;

    const isFriendly = type === 'overdrive_cell' || type === 'repair_cell';
    const color = isFriendly ? '#7bd88f' : type === 'barrier' ? '#ff8c5a' : '#ffc45a';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    // Corner brackets
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
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const tag =
      type === 'flank_left'
        ? 'RAMA ← escudo [J]'
        : type === 'flank_right'
        ? 'RAMA → escudo [L]'
        : type === 'flank_cross'
        ? `SEÑAL ⇄ cruza · escudo ${side === 'left' ? '[J]' : '[L]'}`
        : type === 'barrier'
        ? `TRONCO · ${distMeters} m`
        : type === 'overdrive_cell'
        ? 'TURBO'
        : 'BOTIQUÍN';
    // Keep the label inside the canvas: near the right edge it grows leftwards
    const tagWidth = ctx.measureText(tag).width;
    const tagX = clampLabelX(x, tagWidth, TRACK_CONFIG.WORLD_WIDTH);
    ctx.fillText(tag, tagX, y - 4);
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

    // Paw-shaped protective bubbles on the active flanks
    if (state.world_state.active_shields.left) {
      this.drawFlankEnergyShield(x - TRACK_CONFIG.SHIELD_OFFSET_X, y, -1);
    }
    if (state.world_state.active_shields.right) {
      this.drawFlankEnergyShield(x + TRACK_CONFIG.SHIELD_OFFSET_X, y, 1);
    }

    // Rescue van seen from above, banking with the steering
    ctx.translate(x, y);
    ctx.rotate(this.smoothBankAngle);

    const bw = w * 0.92;
    const bh = h;

    // Wheels
    ctx.fillStyle = '#111111';
    const wheels: Array<[number, number]> = [
      [-bw / 2 - 3, -bh * 0.32],
      [bw / 2 - 4, -bh * 0.32],
      [-bw / 2 - 3, bh * 0.2],
      [bw / 2 - 4, bh * 0.2]
    ];
    for (const [wx, wy] of wheels) {
      ctx.fillRect(wx, wy, 7, 16);
    }

    // Body in the chosen paint, glowing golden during turbo
    ctx.shadowColor = state.world_state.is_overdrive ? '#ffc94d' : tint.glow;
    ctx.shadowBlur = state.world_state.is_overdrive ? 26 : 14;
    const body = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
    body.addColorStop(0, tint.primary);
    body.addColorStop(0.5, '#ffffff');
    body.addColorStop(1, tint.primary);
    ctx.fillStyle = body;
    this.roundedRect(-bw / 2, -bh / 2, bw, bh, 12);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Windshield
    ctx.fillStyle = '#1d2a36';
    this.roundedRect(-bw / 2 + 6, -bh / 2 + 9, bw - 12, bh * 0.2, 5);
    ctx.fill();

    // Light bar: amber and teal blinking (rescue, not police)
    const blink = Math.floor(Date.now() / 220) % 2 === 0;
    ctx.fillStyle = blink ? '#ffb347' : '#2ec4b6';
    ctx.fillRect(-bw / 2 + 8, -bh * 0.2, (bw - 16) / 2, 5);
    ctx.fillStyle = blink ? '#2ec4b6' : '#ffb347';
    ctx.fillRect(0, -bh * 0.2, (bw - 16) / 2, 5);

    // White roof with a paw print
    ctx.fillStyle = '#f4f1ea';
    this.roundedRect(-bw / 2 + 6, -bh * 0.12, bw - 12, bh * 0.52, 7);
    ctx.fill();
    this.drawPaw(0, bh * 0.15, 11, tint.primary);

    // Headlights and taillights
    ctx.fillStyle = '#fff6d6';
    ctx.fillRect(-bw / 2 + 4, -bh / 2 + 2, 9, 4);
    ctx.fillRect(bw / 2 - 13, -bh / 2 + 2, 9, 4);
    ctx.fillStyle = '#ff5a5f';
    ctx.fillRect(-bw / 2 + 4, bh / 2 - 5, 9, 4);
    ctx.fillRect(bw / 2 - 13, bh / 2 - 5, 9, 4);

    // Side mirrors
    ctx.fillStyle = tint.primary;
    ctx.fillRect(-bw / 2 - 6, -bh * 0.27, 6, 5);
    ctx.fillRect(bw / 2, -bh * 0.27, 6, 5);

    ctx.restore();
  }

  /** Rounded rectangle path (no fill/stroke). */
  private roundedRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** Paw print: one pad and four toes. */
  private drawPaw(cx: number, cy: number, size: number, color: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy + size * 0.25, size * 0.5, size * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    const toes: Array<[number, number]> = [
      [-0.55, -0.3],
      [-0.2, -0.62],
      [0.2, -0.62],
      [0.55, -0.3]
    ];
    for (const [tx, ty] of toes) {
      ctx.beginPath();
      ctx.ellipse(cx + tx * size, cy + ty * size, size * 0.18, size * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawFlankEnergyShield(sx: number, sy: number, dir: -1 | 1): void {
    const { ctx } = this;
    const halfH = TRACK_CONFIG.SHIELD_HALF_HEIGHT;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Soft protective bubble
    const grad = ctx.createLinearGradient(sx - 12 * dir, sy, sx + 18 * dir, sy);
    grad.addColorStop(0, 'rgba(46, 196, 182, 0)');
    grad.addColorStop(0.55, 'rgba(46, 196, 182, 0.45)');
    grad.addColorStop(1, 'rgba(126, 232, 216, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(sx + 4 * dir, sy, 16, halfH, 0, 0, Math.PI * 2);
    ctx.fill();

    // Curved edge matching the collision line
    ctx.strokeStyle = '#7ee8d8';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#2ec4b6';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(sx, sy - halfH);
    ctx.quadraticCurveTo(sx + 14 * dir, sy, sx, sy + halfH);
    ctx.stroke();
    ctx.restore();

    // Paw emblem on the bubble
    ctx.save();
    ctx.globalAlpha = 0.85;
    this.drawPaw(sx + 9 * dir, sy, 9, '#e9fffb');
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

  private drawWeather(weather: WeatherLook, speed: number, dt: number): void {
    const { ctx } = this;
    const { WORLD_WIDTH, WORLD_HEIGHT } = TRACK_CONFIG;

    // Color grade of the current phase (sunset, storm, night, dawn...)
    ctx.save();
    ctx.fillStyle = weather.tint;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ctx.restore();

    // Rain: density depends on the weather
    const drops = Math.round(this.rainDrops.length * weather.rain);
    ctx.save();
    ctx.strokeStyle = 'rgba(200, 225, 255, 0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < this.rainDrops.length; i++) {
      const drop = this.rainDrops[i];
      drop.y += (drop.speed + speed * 2.2) * dt;
      drop.x -= 45 * dt;
      if (drop.y > WORLD_HEIGHT) {
        drop.y = -30;
        drop.x = Math.random() * WORLD_WIDTH;
      }
      if (drop.x < 0) {
        drop.x = WORLD_WIDTH;
      }
      if (i < drops) {
        ctx.moveTo(drop.x, drop.y);
        ctx.lineTo(drop.x - 2, drop.y + drop.length);
      }
    }
    ctx.stroke();
    ctx.restore();

    // Lightning flashes during the storm phases
    if (weather.lightning && Math.random() < dt * 0.22) {
      this.lightningFlash = 1;
      this.shakeIntensity = Math.max(this.shakeIntensity, 3);
    }
    if (this.lightningFlash > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(230, 240, 255, ${this.lightningFlash * 0.32})`;
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      ctx.restore();
      this.lightningFlash = Math.max(0, this.lightningFlash - 3 * dt);
    }

    // Dawn rainbow: reward for crews that reach the last phase
    if (weather.rainbow) {
      const colors = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa'];
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 9;
      colors.forEach((color, i) => {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(WORLD_WIDTH / 2, 520, 470 - i * 9, Math.PI * 1.08, Math.PI * 1.92);
        ctx.stroke();
      });
      ctx.restore();
    }
  }

  /**
   * Animals waiting on the roadside. One appears every RESCUE_EVERY_METERS meters, always
   * the same for both players; when the patrol passes it, it hops on board.
   */
  private drawRoadsideAnimals(state: ServerWorldStatePayload, weather: WeatherLook, dt: number): void {
    const { ctx } = this;
    const distance = state.world_state.distance_traveled;

    // Count rescues (a new match resets the counter)
    const rescued = rescuedCount(distance);
    if (rescued < this.lastRescued) {
      this.lastRescued = rescued;
    }
    if (rescued > this.lastRescued && state.world_state.status === 'running') {
      const newest = animalsBetween(this.lastRescued * RESCUE_EVERY_METERS + 1, rescued * RESCUE_EVERY_METERS).pop();
      const x = newest?.side === 'left' ? TRACK_CONFIG.ROAD_LEFT - 45 : TRACK_CONFIG.ROAD_RIGHT + 45;
      for (let i = 0; i < 6; i++) {
        this.hearts.push({ x: x + (Math.random() - 0.5) * 30, y: this.smoothMechaY, vy: -60 - Math.random() * 60, alpha: 1 });
      }
      this.callouts.push({
        text: '+1 ¡A SALVO! 🐾',
        subtext: `Un ${newest?.kind ?? 'peludito'} subió a bordo · ${rescued} rescatados`,
        x: this.smoothMechaX,
        y: this.smoothMechaY - 95,
        alpha: 1.4,
        color: '#ffc94d'
      });
    }
    this.lastRescued = rescued;

    // Animals still waiting ahead (23.5 px per meter, like the obstacles)
    for (const animal of animalsBetween(distance + 0.01, distance + 36)) {
      const y = this.smoothMechaY - (animal.meter - distance) * 23.5;
      if (y < -40 || y > TRACK_CONFIG.WORLD_HEIGHT + 40) continue;
      const x = animal.side === 'left' ? TRACK_CONFIG.ROAD_LEFT - 45 : TRACK_CONFIG.ROAD_RIGHT + 45;

      // Their own lamp keeps them visible in the storm
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(x, y, 2, x, y, 46);
      halo.addColorStop(0, 'rgba(255, 220, 160, 0.45)');
      halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(x - 46, y - 46, 92, 92);
      ctx.restore();

      this.drawAnimal(x, y, animal.kind, weather.rain > 0.15);
    }

    // Hearts floating up after each rescue
    for (let i = this.hearts.length - 1; i >= 0; i--) {
      const h = this.hearts[i];
      h.y += h.vy * dt;
      h.alpha -= 0.9 * dt;
      if (h.alpha <= 0) {
        this.hearts.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = h.alpha;
      ctx.fillStyle = '#ff6b8a';
      ctx.font = '16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('♥', h.x, h.y);
      ctx.restore();
    }
  }

  /** A small sitting animal seen from above-front, with an umbrella when it rains. */
  private drawAnimal(x: number, y: number, kind: AnimalKind, umbrella: boolean): void {
    const { ctx } = this;
    const fur: Record<AnimalKind, string> = {
      perrito: '#c98b4f',
      cachorro: '#f2d2a2',
      gatito: '#9aa0a8',
      conejito: '#f4f1ea'
    };
    ctx.save();
    ctx.translate(x, y);

    // Tail wagging
    const wag = Math.sin(Date.now() * 0.012) * 0.5;
    ctx.strokeStyle = fur[kind];
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(8, 8);
    ctx.quadraticCurveTo(16, 4 + wag * 6, 15, -4 + wag * 8);
    ctx.stroke();

    // Body and head
    ctx.fillStyle = fur[kind];
    ctx.beginPath();
    ctx.ellipse(0, 8, 10, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -6, 8, 0, Math.PI * 2);
    ctx.fill();

    // Ears by species
    ctx.fillStyle = kind === 'conejito' ? '#f7c6d0' : fur[kind];
    if (kind === 'gatito') {
      ctx.beginPath();
      ctx.moveTo(-7, -9); ctx.lineTo(-5, -17); ctx.lineTo(-1, -12);
      ctx.moveTo(7, -9); ctx.lineTo(5, -17); ctx.lineTo(1, -12);
      ctx.fill();
    } else if (kind === 'conejito') {
      ctx.beginPath();
      ctx.ellipse(-3, -18, 2.5, 7, -0.15, 0, Math.PI * 2);
      ctx.ellipse(3, -18, 2.5, 7, 0.15, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = kind === 'perrito' ? '#8a5a34' : '#d9a86c';
      ctx.beginPath();
      ctx.ellipse(-8, -5, 3.5, 6, 0.3, 0, Math.PI * 2);
      ctx.ellipse(8, -5, 3.5, 6, -0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Eyes and nose
    ctx.fillStyle = '#1b1b1b';
    ctx.beginPath();
    ctx.arc(-3, -7, 1.4, 0, Math.PI * 2);
    ctx.arc(3, -7, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a2a2a';
    ctx.beginPath();
    ctx.arc(0, -3.5, 1.3, 0, Math.PI * 2);
    ctx.fill();

    // Little umbrella
    if (umbrella) {
      ctx.strokeStyle = '#d7d7d7';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(10, -4);
      ctx.lineTo(10, -26);
      ctx.stroke();
      ctx.fillStyle = '#2ec4b6';
      ctx.beginPath();
      ctx.arc(10, -26, 13, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Driver view: headlights and the storm fog that limits what the driver sees.
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
    headGrad.addColorStop(0, 'rgba(255, 244, 214, 0.28)');
    headGrad.addColorStop(0.6, 'rgba(255, 210, 150, 0.08)');
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
      ctx.fillStyle = 'rgba(46, 196, 182, 0.07)';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
  }

  /**
   * Navigator view: overhead radar with tappable lanes to warn the driver.
   */
  private drawNavigatorStealthRadar(state: ServerWorldStatePayload): void {
    void state;
    const { ctx } = this;
    const { ROAD_LEFT, ROAD_WIDTH, LANE_WIDTH, WORLD_HEIGHT } = TRACK_CONFIG;

    ctx.save();
    // Soft map grid
    ctx.strokeStyle = 'rgba(46, 196, 182, 0.08)';
    ctx.lineWidth = 1;
    for (let y = 0; y < WORLD_HEIGHT; y += 60) {
      ctx.beginPath();
      ctx.moveTo(ROAD_LEFT, y);
      ctx.lineTo(ROAD_LEFT + ROAD_WIDTH, y);
      ctx.stroke();
    }

    // Radar sweep
    const scanGrad = ctx.createLinearGradient(0, this.radarSweepY - 48, 0, this.radarSweepY);
    scanGrad.addColorStop(0, 'rgba(46, 196, 182, 0)');
    scanGrad.addColorStop(1, 'rgba(46, 196, 182, 0.2)');
    ctx.fillStyle = scanGrad;
    ctx.fillRect(ROAD_LEFT, this.radarSweepY - 48, ROAD_WIDTH, 48);

    // Tappable lane headers
    ctx.fillStyle = 'rgba(126, 232, 216, 0.9)';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let lane = 0; lane < 3; lane++) {
      const cx = ROAD_LEFT + lane * LANE_WIDTH + LANE_WIDTH * 0.5;
      ctx.fillText(`CARRIL ${lane + 1}`, cx, 108);
    }
    ctx.restore();
  }

  /**
   * In-canvas HUD: speed, phase and weather, rescued animals and shield state.
   */
  private drawStealthFighterCockpitHUD(
    state: ServerWorldStatePayload,
    role: PlayerRole
  ): void {
    const { ctx } = this;
    const width = TRACK_CONFIG.WORLD_WIDTH;
    const ws = state.world_state;
    const weather = weatherForPhase(ws.difficulty_phase);
    const hudColor = role === 'navigator' ? '#7ee8d8' : '#ffd29a';

    ctx.save();
    ctx.fillStyle = hudColor;
    ctx.globalAlpha = 0.8;
    ctx.font = 'bold 12px system-ui, sans-serif';

    ctx.textAlign = 'left';
    ctx.fillText(`VELOCIDAD ${Math.round(state.speed_multiplier.current_speed)}`, 18, 460);
    ctx.fillText(`${ws.difficulty_phase ?? 'Calentamiento'} · ${weather.label}`, 18, 477);
    ctx.fillText(`🐾 A SALVO: ${rescuedCount(ws.distance_traveled)}`, 18, 494);

    ctx.textAlign = 'right';
    ctx.fillText(`ESCUDO IZQ: ${ws.active_shields.left ? 'ACTIVO' : 'LISTO'}`, width - 18, 460);
    ctx.fillText(`ESCUDO DER: ${ws.active_shields.right ? 'ACTIVO' : 'LISTO'}`, width - 18, 477);
    ctx.fillText(role === 'driver' ? 'VISTA: FAROS' : 'VISTA: RADAR', width - 18, 494);
    ctx.restore();
  }

  /**
   * Navigator's "safe lane" marker (K). Display only: the ping still lasts its full ttl in the
   * game (the AI driver relies on it), but on screen it shows ~1.2 s and is kept compact so it
   * does not cover the road. Repeated pings on a lane draw only the newest one.
   */
  private drawTacticalPings(state: ServerWorldStatePayload): void {
    const { ctx } = this;
    const VISIBLE_S = 1.2;
    const FADE_S = 0.35;

    const newestPerLane = new Map<number, (typeof state.world_state.active_pings)[number]>();
    for (const ping of state.world_state.active_pings) newestPerLane.set(ping.lane, ping);

    for (const ping of newestPerLane.values()) {
      const elapsed = ping.max_ttl - ping.ttl;
      if (elapsed >= VISIBLE_S) continue;
      const alpha = Math.min(1, (VISIBLE_S - elapsed) / FADE_S);
      const laneX = getLaneCenterX(ping.lane);
      const targetY = Math.min(ping.y_offset, this.smoothMechaY - 175);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#2ec4b6';
      ctx.fillStyle = 'rgba(46, 196, 182, 0.12)';
      ctx.lineWidth = 2;

      const boxW = TRACK_CONFIG.LANE_WIDTH * 0.7;
      const boxH = 120;
      ctx.fillRect(laneX - boxW * 0.5, targetY - 40, boxW, boxH);
      ctx.strokeRect(laneX - boxW * 0.5, targetY - 40, boxW, boxH);

      // Dashed guide from the vehicle to the safe lane
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(this.smoothMechaX, this.smoothMechaY - 42);
      ctx.lineTo(laneX, targetY + 20);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#7ee8d8';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`CARRIL SEGURO ${ping.lane + 1}`, laneX, targetY - 12);
      ctx.restore();
    }
  }

  private updateAndDrawCallouts(dt: number): void {
    const { ctx } = this;
    for (let i = this.callouts.length - 1; i >= 0; i--) {
      const c = this.callouts[i];
      c.y -= 48 * dt;
      // ~0.7 s on screen (was ~1.4 s): short enough not to cover the road
      c.alpha -= 1.9 * dt;
      if (c.alpha <= 0) {
        this.callouts.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.min(1, c.alpha);
      ctx.fillStyle = 'rgba(20, 16, 22, 0.88)';
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.5;
      this.roundedRect(c.x - 105, c.y - 19, 210, 32, 9);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = c.color;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(c.text, c.x, c.y - 4);

      ctx.fillStyle = '#f3ece2';
      ctx.font = '10px system-ui, sans-serif';
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
    const boxW = 400;
    const boxX = (TRACK_CONFIG.WORLD_WIDTH - boxW) / 2;
    const boxY = 122;
    const boxH = 46;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(4, 12, 22, 0.92)';
    ctx.strokeStyle = event.preset === 'mayday_panic' ? '#ff5a5f' : '#2ec4b6';
    ctx.lineWidth = 2;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    // Animated Voice Oscilloscope Bars
    ctx.fillStyle = ctx.strokeStyle;
    for (let i = 0; i < 8; i++) {
      const barH = 6 + Math.abs(Math.sin(Date.now() * 0.02 + i)) * 20;
      ctx.fillRect(boxX + 14 + i * 6, boxY + 23 - barH * 0.5, 4, barH);
    }

    ctx.textAlign = 'left';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillText(
      `RADIO · ${event.sender_name} (${event.sender_role === 'driver' ? 'PILOTO' : 'NAVEGANTE'})`,
      boxX + 72,
      boxY + 18
    );

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillText(event.label, boxX + 72, boxY + 36);
    ctx.restore();
  }

  private drawCriticalSpeedWarning(countdown: number): void {
    const { ctx } = this;
    const pulse = 0.35 + Math.abs(Math.sin(Date.now() * 0.014)) * 0.55;

    ctx.save();
    ctx.strokeStyle = `rgba(255, 90, 95, ${pulse})`;
    ctx.lineWidth = 12;
    ctx.strokeRect(0, 0, TRACK_CONFIG.WORLD_WIDTH, TRACK_CONFIG.WORLD_HEIGHT);

    ctx.fillStyle = 'rgba(30, 10, 12, 0.9)';
    ctx.strokeStyle = '#ff5a5f';
    ctx.lineWidth = 2;
    this.roundedRect(95, 190, TRACK_CONFIG.WORLD_WIDTH - 190, 58, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ff8a8e';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('¡VELOCIDAD MUY BAJA!', TRACK_CONFIG.WORLD_WIDTH * 0.5, 214);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText(
      `Acelera: el motor se apaga en ${countdown.toFixed(1)} s`,
      TRACK_CONFIG.WORLD_WIDTH * 0.5,
      237
    );
    ctx.restore();
  }

}
