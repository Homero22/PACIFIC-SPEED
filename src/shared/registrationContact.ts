/**
 * Contact data required to register a pair in the paid tournament.
 * Used by the hangar form (instant feedback) and by the server (the real check).
 */
export interface RegistrationContactInput {
  phone?: unknown;
  email?: unknown;
  accept_terms?: unknown;
}

export type RegistrationContactResult =
  | { ok: true; phone: string; email: string }
  | { ok: false; field: 'phone' | 'email' | 'terms'; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Keeps a leading + and digits only: "+593 99-123 4567" → "+593991234567". */
export function normalizePhone(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const digits = text.replace(/\D/g, '');
  return (text.startsWith('+') ? '+' : '') + digits;
}

export function validateRegistrationContact(input: RegistrationContactInput): RegistrationContactResult {
  const phone = normalizePhone(input.phone);
  const digits = phone.replace('+', '');
  if (digits.length < 7 || digits.length > 15) {
    return { ok: false, field: 'phone', message: 'Ingresa un teléfono o WhatsApp válido (7 a 15 dígitos).' };
  }
  const email = String(input.email ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return { ok: false, field: 'email', message: 'Ingresa un correo electrónico válido.' };
  }
  if (input.accept_terms !== true) {
    return { ok: false, field: 'terms', message: 'Debes aceptar las bases del torneo para inscribirte.' };
  }
  return { ok: true, phone, email };
}
