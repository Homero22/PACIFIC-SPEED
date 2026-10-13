import { clamp } from '../shared/math.js';
import type { ClientInputPayload, LaneIndex, PlayerRole } from '../shared/types.js';

export class InputManager {
  private pressedKeys = new Set<string>();
  private touchVector = { x: 0, y: 0 };
  private touchShieldLeft = false;
  private touchShieldRight = false;
  private pendingRadarPulse = false;
  private pendingPingLane: LaneIndex | null = null;
  private cycleLaneCursor: LaneIndex = 1;
  private seqCounter = 0;

  constructor(onAudioUnlock?: () => void) {
    window.addEventListener('keydown', (e) => {
      if (onAudioUnlock) onAudioUnlock();

      // Prevent page scroll on Space or Arrow keys during gameplay
      if (
        ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) &&
        document.activeElement?.tagName !== 'INPUT'
      ) {
        e.preventDefault();
      }

      if (!this.pressedKeys.has(e.code)) {
        this.pressedKeys.add(e.code);

        // One-shot tactical actions for Navigator
        if (e.code === 'KeyK') {
          this.cycleLaneCursor = ((this.cycleLaneCursor + 1) % 3) as LaneIndex;
          this.pendingPingLane = this.cycleLaneCursor;
        } else if (e.code === 'Digit1') {
          this.pendingPingLane = 0;
        } else if (e.code === 'Digit2') {
          this.pendingPingLane = 1;
        } else if (e.code === 'Digit3') {
          this.pendingPingLane = 2;
        } else if (e.code === 'Space') {
          this.pendingRadarPulse = true;
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.pressedKeys.delete(e.code);
    });

    window.addEventListener('blur', () => {
      this.pressedKeys.clear();
      this.touchVector = { x: 0, y: 0 };
      this.touchShieldLeft = false;
      this.touchShieldRight = false;
    });
  }

  public bindTouchControls(
    joystickZone: HTMLElement | null,
    joystickKnob: HTMLElement | null,
    btnShieldLeft: HTMLElement | null,
    btnShieldRight: HTMLElement | null,
    btnPing: HTMLElement | null,
    btnRadar: HTMLElement | null
  ): void {
    if (joystickZone && joystickKnob) {
      let activePointerId: number | null = null;
      const maxRadius = 46;

      const updateJoystick = (clientX: number, clientY: number) => {
        const rect = joystickZone.getBoundingClientRect();
        const centerX = rect.left + rect.width * 0.5;
        const centerY = rect.top + rect.height * 0.5;
        const dx = clientX - centerX;
        const dy = clientY - centerY;
        const dist = Math.hypot(dx, dy);
        const clampedDist = Math.min(dist, maxRadius);
        const angle = Math.atan2(dy, dx);

        const knobX = Math.cos(angle) * clampedDist;
        const knobY = Math.sin(angle) * clampedDist;
        joystickKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;

        this.touchVector.x = clamp(knobX / maxRadius, -1, 1);
        this.touchVector.y = clamp(-knobY / maxRadius, -1, 1);
      };

      const resetJoystick = () => {
        activePointerId = null;
        joystickKnob.style.transform = 'translate(0px, 0px)';
        this.touchVector.x = 0;
        this.touchVector.y = 0;
      };

      joystickZone.addEventListener('pointerdown', (e) => {
        activePointerId = e.pointerId;
        joystickZone.setPointerCapture(e.pointerId);
        updateJoystick(e.clientX, e.clientY);
      });

      joystickZone.addEventListener('pointermove', (e) => {
        if (e.pointerId === activePointerId) {
          updateJoystick(e.clientX, e.clientY);
        }
      });

      joystickZone.addEventListener('pointerup', resetJoystick);
      joystickZone.addEventListener('pointercancel', resetJoystick);
    }

    if (btnShieldLeft) {
      btnShieldLeft.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchShieldLeft = true;
      });
      btnShieldLeft.addEventListener('pointerup', () => {
        this.touchShieldLeft = false;
      });
      btnShieldLeft.addEventListener('pointerleave', () => {
        this.touchShieldLeft = false;
      });
    }

    if (btnShieldRight) {
      btnShieldRight.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchShieldRight = true;
      });
      btnShieldRight.addEventListener('pointerup', () => {
        this.touchShieldRight = false;
      });
      btnShieldRight.addEventListener('pointerleave', () => {
        this.touchShieldRight = false;
      });
    }

    if (btnPing) {
      btnPing.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.cycleLaneCursor = ((this.cycleLaneCursor + 1) % 3) as LaneIndex;
        this.pendingPingLane = this.cycleLaneCursor;
      });
    }

    if (btnRadar) {
      btnRadar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.pendingRadarPulse = true;
      });
    }
  }

  public triggerCanvasLanePing(lane: LaneIndex): void {
    this.pendingPingLane = lane;
  }

  public sampleInputPayload(playerId: string, role: PlayerRole): ClientInputPayload {
    // Driver steering & throttle
    let x = this.touchVector.x;
    let y = this.touchVector.y;

    if (this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft')) x -= 1;
    if (this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight')) x += 1;
    if (this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp')) y += 1;
    if (this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown')) y -= 1;

    x = clamp(x, -1, 1);
    y = clamp(y, -1, 1);

    // Navigator shields & pings
    const shieldLeft = this.pressedKeys.has('KeyJ') || this.touchShieldLeft;
    const shieldRight = this.pressedKeys.has('KeyL') || this.touchShieldRight;
    const radarPulse = this.pendingRadarPulse;
    const pingLane = this.pendingPingLane;

    if (role === 'navigator') {
      this.pendingRadarPulse = false;
      this.pendingPingLane = null;
    }

    return {
      player_id: playerId,
      role,
      input_vector: { x, y },
      action_flags: {
        shield_left: shieldLeft,
        shield_right: shieldRight,
        radar_pulse: radarPulse,
        ping_lane: pingLane
      },
      timestamp: Date.now(),
      seq: ++this.seqCounter
    };
  }
}
