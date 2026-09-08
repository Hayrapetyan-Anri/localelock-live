import { createHash } from 'node:crypto';

export interface SrtCue {
  cue_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(milli).padStart(3, '0')}`;
}

export function cuesToSrt(cues: SrtCue[]): string {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.cue_id - b.cue_id);
  return sorted
    .map((cue, i) => `${i + 1}\n${formatTimecode(cue.start_ms)} --> ${formatTimecode(cue.end_ms)}\n${cue.text.normalize('NFC')}\n`)
    .join('\n');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function srtFilename(titleSlug: string, locale: string, version: number): string {
  return `${titleSlug}.${locale}.v${version}.approved.srt`;
}

export function slugifyTitle(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface SrtBuild {
  text: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  cue_count: number;
  filename: string;
}

export function buildSrt(cues: SrtCue[], titleName: string, locale: string, version: number): SrtBuild {
  const text = cuesToSrt(cues);
  const bytes = new TextEncoder().encode(text);
  return {
    text,
    bytes,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    cue_count: cues.length,
    filename: srtFilename(slugifyTitle(titleName), locale, version),
  };
}
