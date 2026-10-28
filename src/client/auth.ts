/**
 * Player sign-in with Google (Firebase Auth). Only the tournament needs it; practice stays open.
 * The Firebase SDK is loaded on demand so the game itself loads as fast as before.
 */
import type { Auth, User } from 'firebase/auth';

export interface PlayerAccount {
  uid: string;
  email: string | null;
  name: string | null;
}

interface AuthConfig {
  enabled: boolean;
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  appId?: string;
}

type Listener = (account: PlayerAccount | null) => void;

class PlayerAuth {
  private auth: Auth | null = null;
  private ready: Promise<boolean> | null = null;
  private listeners = new Set<Listener>();
  private account: PlayerAccount | null = null;
  public enabled = false;

  /** Loads the config and the SDK once; resolves false when sign-in is not configured. */
  public init(): Promise<boolean> {
    if (!this.ready) this.ready = this.load();
    return this.ready;
  }

  private async load(): Promise<boolean> {
    try {
      const cfg = (await (await fetch('/api/auth/config')).json()) as AuthConfig;
      if (!cfg.enabled || !cfg.apiKey || !cfg.projectId || !cfg.appId) return false;
      const [{ initializeApp }, authMod] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
      const app = initializeApp({
        apiKey: cfg.apiKey,
        authDomain: cfg.authDomain,
        projectId: cfg.projectId,
        appId: cfg.appId
      });
      this.auth = authMod.getAuth(app);
      this.auth.languageCode = 'es';
      // Finish a redirect sign-in (used when the popup is blocked, e.g. some phones)
      await authMod.getRedirectResult(this.auth).catch(() => null);
      authMod.onAuthStateChanged(this.auth, (user: User | null) => {
        this.account = user ? { uid: user.uid, email: user.email, name: user.displayName } : null;
        this.listeners.forEach((fn) => fn(this.account));
      });
      this.enabled = true;
      return true;
    } catch {
      return false;
    }
  }

  public onChange(fn: Listener): void {
    this.listeners.add(fn);
    fn(this.account);
  }

  public get current(): PlayerAccount | null {
    return this.account;
  }

  public async signInWithGoogle(): Promise<void> {
    if (!(await this.init()) || !this.auth) throw new Error('El inicio de sesión no está disponible.');
    const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await import('firebase/auth');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(this.auth, provider);
    } catch (err: any) {
      const code = String(err?.code || '');
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(this.auth, provider);
        return;
      }
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      throw err;
    }
  }

  public async signOut(): Promise<void> {
    if (!this.auth) return;
    const { signOut } = await import('firebase/auth');
    await signOut(this.auth);
  }

  /** Fresh Firebase ID token for the server, or null when signed out. */
  public async idToken(): Promise<string | null> {
    // Wait for the saved session to be restored (e.g. right after returning from Payphone)
    if (!(await this.init()) || !this.auth) return null;
    await this.auth.authStateReady();
    const user = this.auth.currentUser;
    if (!user) return null;
    try {
      return await user.getIdToken();
    } catch {
      return null;
    }
  }
}

export const playerAuth = new PlayerAuth();
