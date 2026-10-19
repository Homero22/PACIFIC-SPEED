import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdPlacement, resolveAdMode } from '../adPlacement.js';

type Pushed = Record<string, unknown> & {
  type?: string;
  beforeReward?: (show: () => void) => void;
  adViewed?: () => void;
  adDismissed?: () => void;
  beforeAd?: () => void;
  afterAd?: () => void;
  adBreakDone?: (info: { breakStatus?: string }) => void;
};

let pushed: Pushed[];

beforeEach(() => {
  vi.useFakeTimers();
  pushed = [];
  vi.stubGlobal('window', {
    adsbygoogle: { push: (o: Pushed) => pushed.push(o) },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function offer() {
  return {
    onAvailable: vi.fn(),
    onUnavailable: vi.fn(),
    onRewarded: vi.fn(),
    onDismissed: vi.fn(),
    onAdStart: vi.fn(),
    onAdEnd: vi.fn()
  };
}

describe('Ad mode', () => {
  it('is off in production until Google approves H5 Games Ads', () => {
    expect(resolveAdMode({ hostname: 'patrulla.example.com', search: '' }, false)).toBe('off');
    expect(resolveAdMode({ hostname: 'patrulla.example.com', search: '' }, true)).toBe('live');
  });

  it('uses Google test mode on localhost or with ?adtest=1', () => {
    expect(resolveAdMode({ hostname: 'localhost', search: '' }, false)).toBe('test');
    expect(resolveAdMode({ hostname: 'patrulla.example.com', search: '?adtest=1' }, true)).toBe('test');
  });
});

describe('Rewarded repair', () => {
  it('with ads off it never calls Google and offers the free repair', () => {
    const ads = new AdPlacement('off');
    const o = offer();
    ads.requestReward(o);
    expect(o.onUnavailable).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveLength(0);
  });

  it('repairs only when the ad was watched to the end', () => {
    const ads = new AdPlacement('test');
    const o = offer();
    ads.requestReward(o);
    const brk = pushed.find((p) => p.type === 'reward')!;
    const show = vi.fn();
    brk.beforeReward!(show);
    expect(o.onAvailable).toHaveBeenCalledWith(show);
    brk.adDismissed!();
    expect(o.onRewarded).not.toHaveBeenCalled();
    brk.adViewed!();
    expect(o.onRewarded).toHaveBeenCalledTimes(1);
  });

  it('falls back to the free repair when no ad fills', () => {
    const ads = new AdPlacement('test');
    const o = offer();
    ads.requestReward(o);
    pushed.find((p) => p.type === 'reward')!.adBreakDone!({ breakStatus: 'frequencyCapped' });
    expect(o.onUnavailable).toHaveBeenCalledTimes(1);
    expect(o.onAvailable).not.toHaveBeenCalled();
  });

  it('falls back after 4 s if Google never answers (ad blocker)', () => {
    const ads = new AdPlacement('test');
    const o = offer();
    ads.requestReward(o);
    vi.advanceTimersByTime(4000);
    expect(o.onUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe('Ad between missions', () => {
  it('always continues to the next mission, with or without an ad', () => {
    const ads = new AdPlacement('test');
    const done = vi.fn();
    ads.showBetweenMissions(vi.fn(), vi.fn(), done);
    pushed.find((p) => p.type === 'next')!.adBreakDone!({});
    expect(done).toHaveBeenCalledTimes(1);

    const done2 = vi.fn();
    ads.showBetweenMissions(vi.fn(), vi.fn(), done2);
    vi.advanceTimersByTime(6000);
    expect(done2).toHaveBeenCalledTimes(1);
  });
});
