/**
 * Google Analytics 4 events for the game (the gtag snippet lives in index.html).
 * Never send personal data here: no nicknames, phones, e-mails, pass codes or payment ids.
 */
type GtagParams = Record<string, string | number | boolean | undefined>;

export function track(event: string, params: GtagParams = {}): void {
  try {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (typeof gtag === 'function') gtag('event', event, params);
  } catch {
    // Analytics blocked or not loaded: the game keeps working
  }
}
