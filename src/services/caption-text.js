const CAPTION_PERIODS = /[.。．｡]/g;

export function removeCaptionPeriods(text) {
  return String(text ?? '').replace(CAPTION_PERIODS, '');
}
