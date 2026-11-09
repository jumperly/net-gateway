import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Base32 without the look-alikes 0/O and 1/I: 8 letters are 40 bits. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;

/** A fresh pairing code of the local helper, as stored: `PAIRING_CODE_LENGTH` letters. */
export function newPairingCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += ALPHABET[random(ALPHABET.length)];
  return code;
}

/** A code as people type it (`k7pq-m2xd`, spaces) in the stored form (`K7PQM2XD`). */
export function normalizePairingCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** `K7PQM2XD` → `K7PQ-M2XD`. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const valid = (code: unknown): code is string =>
  typeof code === 'string' &&
  code.length === PAIRING_CODE_LENGTH &&
  [...code].every((c) => ALPHABET.includes(c));

export interface PairingFile {
  read(path: string): string;
  write(path: string, text: string): void;
}

const fsFile: PairingFile = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    // Readable by the user only: the code lets a program on this machine use the helper.
    writeFileSync(path, text, { mode: 0o600 });
  },
};

/**
 * The helper's pairing code from `path` (`{ "code": "…" }`), made and saved on the first start or
 * when `renew` asks for a new one (the page must then be paired again).
 */
export function loadPairing(
  path: string,
  opts: { renew?: boolean; file?: PairingFile; random?: (max: number) => number } = {},
): { code: string; created: boolean } {
  const file = opts.file ?? fsFile;
  if (!opts.renew) {
    try {
      const saved = (JSON.parse(file.read(path)) as { code?: unknown }).code;
      if (valid(saved)) return { code: saved, created: false };
    } catch {
      // no file yet, or not ours: a new code
    }
  }
  const code = newPairingCode(opts.random);
  file.write(path, `${JSON.stringify({ code }, null, 2)}\n`);
  return { code, created: true };
}
