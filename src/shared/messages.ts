import type { PageMeasurements } from '../core/types'

export type ContentRequest =
  | { type: 'measure' }
  | { type: 'hideFixed' }
  | { type: 'scrollTo'; y: number }
  | { type: 'restore' }

export type ContentResponse =
  | { ok: true; measurements?: PageMeasurements }
  | { ok: false; error: string }

export type OffscreenRequest =
  | { type: 'beginCapture'; width: number; height: number }
  | { type: 'addFrame'; dataUrl: string; destY: number; sourceHeight: number }
  | { type: 'finishCapture'; toClipboard: boolean; toDownload: boolean; filename: string }
  | { type: 'abortCapture' }

export type OffscreenResponse = { ok: true } | { ok: false; error: string }
