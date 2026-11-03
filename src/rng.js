/* A seeded pseudo-random generator.
 *
 * Math.random() cannot be seeded, which means a game that uses it can never be
 * replayed and a failing test can never be reproduced. This is the single
 * decision that makes the rest of the suite possible: given the same seed, the
 * same tiles appear in the same cells in the same order, every time and on
 * every machine.
 *
 * mulberry32 — small, fast, and good enough for placing tiles. It is not
 * cryptographically secure and nothing here needs it to be.
 */

export function createRng(seed = 1) {
  // Coerce to a 32-bit integer so string seeds and floats behave predictably.
  let state = Math.imul(seed >>> 0 || 1, 1) >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Float in [0, 1). */
    next,
    /** Integer in [0, bound). */
    int: (bound) => Math.floor(next() * bound),
    /** One element of a non-empty array. */
    pick: (items) => items[Math.floor(next() * items.length)],
    /** The current state, so a game can be saved and resumed mid-sequence. */
    getState: () => state,
    setState: (value) => {
      state = value >>> 0;
    },
  };
}

/** Turn an arbitrary string into a usable numeric seed. */
export function seedFromString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
