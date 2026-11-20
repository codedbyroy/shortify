const CONSONANTS = 'bdfghjklmnprstvz';
const VOWELS = 'aeiou';

function letter(alphabet: string) {
  const limit = 256 - (256 % alphabet.length);
  const byte = new Uint8Array(1);
  do { crypto.getRandomValues(byte); } while (byte[0] >= limit);
  return alphabet[byte[0] % alphabet.length];
}

// Five letters you can say aloud. The database remains the authority on uniqueness.
export function memorableCode() {
  return [CONSONANTS, VOWELS, CONSONANTS, VOWELS, CONSONANTS].map(letter).join('');
}
