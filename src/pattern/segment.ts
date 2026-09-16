/**
 * Browser-side subject segmentation (WASM). The MediaPipe model assets live in
 * public/mediapipe and are fetched on first use only, so the feature costs
 * nothing until selected. A general-subject provider (e.g. ISNet via ONNX
 * Runtime) can plug into the same ForegroundMask contract later - the engine
 * only cares about the mask.
 */
import type { InputImage, Results, SelfieSegmentation } from '@mediapipe/selfie_segmentation';

export type ForegroundMask = {
  width: number;
  height: number;
  /** Per-pixel foreground probability 0-255, row-major, at image resolution. */
  data: Uint8ClampedArray;
};

type MpModule = typeof import('@mediapipe/selfie_segmentation');

const PERSON_MODEL_FILES = [
  'selfie_segmentation_solution_simd_wasm_bin.js',
  'selfie_segmentation_solution_simd_wasm_bin.wasm',
  'selfie_segmentation_solution_simd_wasm_bin.data',
  'selfie_segmentation.binarypb',
  'selfie_segmentation.tflite',
];
const PERSON_MODEL_CACHE_KEY = 'pindou.mediapipe.person.v1';

let segmenter: SelfieSegmentation | undefined;
let segmenterReady: Promise<SelfieSegmentation> | undefined;
let pendingResolve: ((r: Results) => void) | undefined;

function assetUrl(file: string): string {
  return new URL(`mediapipe/${file}`, document.baseURI).href;
}

function getSegmenter(): Promise<SelfieSegmentation> {
  if (segmenter) return Promise.resolve(segmenter);
  if (!segmenterReady) {
    segmenterReady = (async () => {
      const mod: MpModule = await import('@mediapipe/selfie_segmentation');
      const instance = new mod.SelfieSegmentation({ locateFile: assetUrl });
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

/** Whether the person model finished downloading in a previous session (hint only - the
 * browser HTTP cache is the real store and may still be evicted). */
export function isPersonModelCached(): boolean {
  try {
    return window.localStorage.getItem(PERSON_MODEL_CACHE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Warm the browser HTTP cache with the person-segmentation model files and
 * report byte-level progress (0-1). MediaPipe refetches the same URLs later and
 * hits the warm cache, so the real download cost shows up here instead of an
 * invisible wait inside send().
 */
export async function prefetchPersonModel(onProgress?: (ratio: number) => void): Promise<void> {
  const files = PERSON_MODEL_FILES.map((file) => ({ url: assetUrl(file), loaded: 0, total: 0 }));
  const report = () => {
    const total = files.reduce((sum, f) => sum + f.total, 0);
    const loaded = files.reduce((sum, f) => sum + f.loaded, 0);
    onProgress?.(total > 0 ? Math.min(loaded / total, 1) : 0);
  };
  await Promise.all(
    files.map(async (f) => {
      const res = await fetch(f.url);
      if (!res.ok || !res.body) throw new Error(`模型文件下载失败（HTTP ${res.status}）`);
      f.total = Number(res.headers.get('content-length') ?? 0);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        f.loaded += value?.byteLength ?? 0;
        report();
      }
      f.loaded = Math.max(f.loaded, f.total);
      report();
    }),
  );
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
