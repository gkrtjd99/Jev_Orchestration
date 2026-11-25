// Rules for the name a member is shown under.
import { ValidationError } from '../util/errors.mjs';

export const MAX_NAME_LENGTH = 20;

// What a person counts as one character: an accented letter, a Hangul syllable or an emoji sequence is one.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function characterCount(text) {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/** Trims the name and collapses runs of whitespace into one space. */
export function normalizeDisplayName(raw) {
  if (typeof raw !== 'string') throw new ValidationError('INVALID_NAME', 'A display name must be text');
  const clean = raw.trim().replace(/\s+/g, ' ');
  return clean.normalize('NFC');
}

/** Returns the cleaned-up name, or throws when it is empty or longer than MAX_NAME_LENGTH characters. */
export function validateDisplayName(raw) {
  const name = normalizeDisplayName(raw);
  if (name.length === 0) throw new ValidationError('NAME_REQUIRED', 'A display name is required');
  if (characterCount(name) > MAX_NAME_LENGTH) {
    throw new ValidationError('NAME_TOO_LONG', `A display name can have at most ${MAX_NAME_LENGTH} characters`, { max: MAX_NAME_LENGTH });
  }
  return name;
}

/** Two names that give the same key are the same name as far as the directory is concerned. */
export function nameKey(name) {
  return normalizeDisplayName(name).toLowerCase().normalize('NFC');
}
