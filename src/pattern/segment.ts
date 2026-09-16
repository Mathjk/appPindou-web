/**
 * Browser-side subject segmentation (WASM). The model assets are fetched once
 * with visible progress, turned into in-memory Blob URLs, and handed to
 * MediaPipe via locateFile - so every internal request (worker importScripts,
 * graph/model fetches) resolves from memory and never touches the network
 * again. If the same-origin copy stalls, the loader retries from the jsdelivr
 * CDN. A general-subject provider (e.g. ISNet via ONNX Runtime) can plug into
 * the same ForegroundMask contract later - the engine only cares about masks.
 */
import type { InputImage, Results, SelfieSegmentation } from '@mediapipe/selfie_segmentation';

export type ForegroundMask = {
  width: number;
  height: number;
  /** Per-pixel foreground probability 0-255, row-major, at image resolution. */
  data: Uint8ClampedArray;
};

type MpModule = typeof import('@mediapipe/selfie_segmentation');

// Exact byte sizes of the bundled @mediapipe/selfie_segmentation@0.1 assets -
// hardcoded because some hosts drop Content-Length on compressed responses,
// which would leave the progress bar stuck at 0%.
const PERSON_MODEL_FILES: Array<{ file: string; bytes: number }> = [
  { file: 'selfie_segmentation_solution_simd_wasm_bin.js', bytes: 276493 },
  { file: 'selfie_segmentation_solution_simd_wasm_bin.wasm', bytes: 5694839 },
  { file: 'selfie_segmentation.binarypb', bytes: 362 },
  { file: 'selfie_segmentation.tflite', bytes: 249024 },
];
const PERSON_MODEL_TOTAL = PERSON_MODEL_FILES.reduce((sum, f) => sum + f.bytes, 0);
const PERSON_MODEL_CACHE_KEY = 'pindou.mediapipe.person.v1';
const CDN_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/';
const STALL_MS = 12_000;

let segmenter: SelfieSegmentation | undefined;
let segmenterReady: Promise<SelfieSegmentation> | undefined;
let pendingResolve: ((r: Results) => void) | undefined;

/** file name -> in-memory blob URL; populated by prefetchPersonModel. */
const blobUrls = new Map<string, string>();
/** Base URL that successfully served the files (same-origin or CDN fallback). */
let resolvedBase = '';

function defaultBase(): string {
  return new URL('mediapipe/', document.baseURI).href;
}

function locateFile(file: string): string {
  return blobUrls.get(file) ?? `${resolvedBase || defaultBase()}${file}`;
}

/** Whether the person model finished downloading in a previous session (hint only - the
 * browser HTTP cache is the real store and may still be evicted). */
export function isPersonModelCached(): boolean {
  try {
    return window.localStorage.getItem(PERSON_MODEL_CACHE_KEY) === '1';
  } catch {
    return false;
  }
}

/** fetch -> Uint8Array with a stall watchdog: no new bytes for STALL_MS aborts
 *  the request so the loader can fail over to the next mirror instead of
 *  spinning forever on a throttled connection. */
async function fetchWithWatchdog(url: string, onBytes: (loaded: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const controller = new AbortController();
  let loaded = 0;
  let lastLoaded = -1;
  const watchdog = setInterval(() => {
    if (loaded === lastLoaded) controller.abort();
    else lastLoaded = loaded;
  }, STALL_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onBytes(loaded);
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    clearInterval(watchdog);
  }
}

/**
 * Download the person-segmentation model files with real byte-level progress
 * (0-1) and register them as Blob URLs. MediaPipe internals later consume the
 * blobs through locateFile, so a successful prefetch guarantees the whole load
 * works offline-of-the-network. Tries same-origin first, then the CDN mirror.
 */
export async function prefetchPersonModel(onProgress?: (ratio: number) => void): Promise<void> {
  let lastError: unknown;
  for (const base of [defaultBase(), CDN_BASE_URL]) {
    try {
      const loaded = new Array<number>(PERSON_MODEL_FILES.length).fill(0);
      const report = () => {
        const sum = loaded.reduce((a, b) => a + b, 0);
        onProgress?.(Math.min(sum / PERSON_MODEL_TOTAL, 0.99));
      };
      const buffers = await Promise.all(
        PERSON_MODEL_FILES.map(async (f, i) => ({
          file: f.file,
          bytes: await fetchWithWatchdog(base + f.file, (n) => {
            loaded[i] = n;
            report();
          }),
        })),
      );
      for (const { file, bytes } of buffers) {
        const old = blobUrls.get(file);
        if (old) URL.revokeObjectURL(old);
        blobUrls.set(file, URL.createObjectURL(new Blob([bytes])));
      }
      resolvedBase = base;
      onProgress?.(1);
      return;
    } catch (error) {
      lastError = error;
      onProgress?.(0);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模型下载失败');
}

function getSegmenter(): Promise<SelfieSegmentation> {
  if (segmenter) return Promise.resolve(segmenter);
  if (!segmenterReady) {
    segmenterReady = (async () => {
      const mod: MpModule = await import('@mediapipe/selfie_segmentation');
      const instance = new mod.SelfieSegmentation({ locateFile });
      // modelSelection 0 = general model (accurate full-body portraits);
      // 1 = landscape model (faster, tuned for half-body selfies).
      instance.setOptions({ modelSelection: 0 });
      instance.onResults((r: Results) => {
        const resolve = pendingResolve;
        pendingResolve = undefined;
        resolve?.(r);
      });
      segmenter = instance;
      return instance;
    })();
    segmenterReady.catch(() => {
      segmenterReady = undefined;
    });
  }
  return segmenterReady;
}

/**
 * Run person segmentation on a source image/canvas and return the foreground
 * mask resampled to (width x height) - normally the exact size of the decoded
 * pixels so it can feed generateBeadGrid's segmentationMask directly.
 */
export async function segmentPerson(source: InputImage, width: number, height: number): Promise<ForegroundMask> {
  const seg = await getSegmenter();
  if (pendingResolve) throw new Error('分割正在进行中');
  const results = await new Promise<Results>((resolve, reject) => {
    pendingResolve = resolve;
    seg.send({ image: source }).catch((error: unknown) => {
      pendingResolve = undefined;
      reject(error instanceof Error ? error : new Error('人像分割失败'));
    });
  });
  const maskSource = results.segmentationMask;
  if (!maskSource) throw new Error('分割结果为空');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 Canvas');
  context.drawImage(maskSource, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4] ?? 0;
  try {
    window.localStorage.setItem(PERSON_MODEL_CACHE_KEY, '1');
  } catch {
    // storage unavailable - progress hint only
  }
  return { width, height, data };
}
