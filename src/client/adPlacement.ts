/**
 * Google H5 Games Ads (Ad Placement API) — rewarded repair and an ad between missions.
 *
 * Modes:
 * - 'off'  : no ad calls at all (default until Google approves the account for H5 Games Ads).
 * - 'test' : Google's testing mode (fake ads). On with localhost or ?adtest=1; index.html
 *            adds data-adbreak-test="on" to the AdSense script tag in that case.
 * - 'live' : real ads. Only when H5_ADS_APPROVED is true.
 *
 * Using adBreak() before approval can put the AdSense account at risk, so keep
 * H5_ADS_APPROVED false until Google confirms the H5 Games Ads sign-up.
 */
export const H5_ADS_APPROVED = false;

export type AdMode = 'off' | 'test' | 'live';

interface AdBreakConfig {
  type: 'preroll' | 'start' | 'pause' | 'next' | 'browse' | 'reward';
  name: string;
  beforeAd?: () => void;
  afterAd?: () => void;
  beforeReward?: (showAdFn: () => void) => void;
  adDismissed?: () => void;
  adViewed?: () => void;
  adBreakDone?: (placementInfo: { breakStatus?: string }) => void;
}

interface AdConfigOptions {
  preloadAdBreaks?: 'on' | 'auto';
  sound?: 'on' | 'off';
}

type AdsQueue = Array<AdBreakConfig | AdConfigOptions>;

/** Test mode: local development, or an explicit ?adtest=1 (same rule as the inline script in index.html). */
export function isAdTestRequested(location: Pick<Location, 'hostname' | 'search'>): boolean {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local || new URLSearchParams(location.search).get('adtest') === '1';
}

export function resolveAdMode(location: Pick<Location, 'hostname' | 'search'>, approved = H5_ADS_APPROVED): AdMode {
  if (isAdTestRequested(location)) return 'test';
  return approved ? 'live' : 'off';
}

export interface RewardOffer {
  /** An ad is ready: show the "watch and repair" button; calling show() plays it. */
  onAvailable: (show: () => void) => void;
  /** No ad this time (none filled, capped, blocked, or ads off). */
  onUnavailable: () => void;
  /** Watched to the end: grant the repair. */
  onRewarded: () => void;
  /** Closed early: no repair. */
  onDismissed: () => void;
  /** Pause/mute around the ad itself. */
  onAdStart: () => void;
  onAdEnd: () => void;
}

export class AdPlacement {
  public readonly mode: AdMode;
  private rewardInFlight = false;

  constructor(mode: AdMode) {
    this.mode = mode;
    if (mode === 'off') return;
    const w = window as unknown as { adsbygoogle?: AdsQueue };
    w.adsbygoogle = w.adsbygoogle || [];
    this.adConfig({ preloadAdBreaks: 'on', sound: 'on' });
  }

  public get enabled(): boolean {
    return this.mode !== 'off';
  }

  public setSound(on: boolean): void {
    if (this.enabled) this.adConfig({ sound: on ? 'on' : 'off' });
  }

  /** Asks Google for a rewarded ad. Exactly one of onAvailable / onUnavailable is called. */
  public requestReward(offer: RewardOffer): void {
    if (!this.enabled || this.rewardInFlight) {
      offer.onUnavailable();
      return;
    }
    this.rewardInFlight = true;
    let offered = false;
    let settled = false;
    // If Google never answers (blocked script, ad blocker), fall back after a few seconds
    const fallback = window.setTimeout(() => {
      if (!offered && !settled) {
        settled = true;
        offer.onUnavailable();
      }
    }, 4000);
    this.adBreak({
      type: 'reward',
      name: 'reparar-vehiculo',
      beforeAd: offer.onAdStart,
      afterAd: offer.onAdEnd,
      beforeReward: (showAdFn) => {
        if (settled) return;
        offered = true;
        window.clearTimeout(fallback);
        offer.onAvailable(showAdFn);
      },
      adViewed: offer.onRewarded,
      adDismissed: offer.onDismissed,
      adBreakDone: () => {
        this.rewardInFlight = false;
        window.clearTimeout(fallback);
        if (!offered && !settled) {
          settled = true;
          offer.onUnavailable();
        }
      }
    });
  }

  /** Full-screen ad between missions; `done` always runs (ad or not). */
  public showBetweenMissions(onAdStart: () => void, onAdEnd: () => void, done: () => void): void {
    if (!this.enabled) {
      done();
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done();
    };
    // Never leave the player stuck if the API does not answer
    const fallback = window.setTimeout(finish, 6000);
    this.adBreak({
      type: 'next',
      name: 'otra-mision',
      beforeAd: () => {
        window.clearTimeout(fallback);
        onAdStart();
      },
      afterAd: onAdEnd,
      adBreakDone: () => {
        window.clearTimeout(fallback);
        finish();
      }
    });
  }

  private adBreak(config: AdBreakConfig): void {
    this.push(config);
  }

  private adConfig(options: AdConfigOptions): void {
    this.push(options);
  }

  private push(item: AdBreakConfig | AdConfigOptions): void {
    try {
      const w = window as unknown as { adsbygoogle: AdsQueue };
      w.adsbygoogle.push(item);
    } catch {
      // Ad script blocked or failed: the game keeps working without ads
    }
  }
}
