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
  return { width, height, data };
}
