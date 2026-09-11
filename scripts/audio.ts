/**
 * The duplicate-recording test, shared by the ongoing check (validate-pairs.ts)
 * and the gate the sync puts in front of every write (sync-from-lms.ts).
 *
 * Speech drives volume up and down in a pattern that is effectively a
 * fingerprint of a take, and it survives re-encoding. So correlating the
 * loudness envelopes of two audio tracks separates them cleanly: two encodes of
 * one recording score ~1.0, while the same screencast narrated twice scores
 * below 0.2 — across all 28 confirmed pairs in this catalogue the highest was
 * 0.189. This is what caught five English recordings filed as Malayalam during
 * the original import.
 *
 * One copy, because a threshold that differs between the check and the gate
 * would mean the check passing things the gate refuses, or worse.
 */

/** How much of each file to compare. Enough to be decisive, short enough that
 *  ffmpeg stops downloading early. */
const SECONDS = 60;
const RATE = 8000;
/** 100ms windows — long enough to smooth out waveform phase, short enough to
 *  track the rhythm of speech. */
const WINDOW = RATE / 10;

/** Above this, the two files are the same recording. */
export const SAME_RECORDING = 0.9;
/** Between this and SAME_RECORDING, no verdict — it wants a human ear. */
export const NEEDS_AN_EAR = 0.4;

export async function envelope(url: string): Promise<Float64Array | null> {
  const proc = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", url, "-t", String(SECONDS),
     "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [buf] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  if (proc.exitCode !== 0 || buf.byteLength === 0) return null;

  const pcm = new Int16Array(buf);
  const out = new Float64Array(Math.floor(pcm.length / WINDOW));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = i * WINDOW; j < (i + 1) * WINDOW; j++) sum += pcm[j]! ** 2;
    out[i] = Math.sqrt(sum / WINDOW);
  }
  return out;
}

/** Pearson correlation over the overlapping stretch. NaN when there isn't
 *  enough audio on one side to say anything. */
export function correlate(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return NaN;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma, y = b[i]! - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db);
}

/** Correlates two files directly. NaN if either one won't decode. */
export async function compare(aUrl: string, bUrl: string): Promise<number> {
  const [a, b] = await Promise.all([envelope(aUrl), envelope(bUrl)]);
  return a && b ? correlate(a, b) : NaN;
}

export function verdictFor(r: number): string {
  if (Number.isNaN(r)) return "decode failed";
  if (r > SAME_RECORDING) return "SAME RECORDING — not bilingual";
  if (r > NEEDS_AN_EAR) return "unclear — needs an ear";
  return "two recordings, good";
}

export const AUDIO_SECONDS = SECONDS;
