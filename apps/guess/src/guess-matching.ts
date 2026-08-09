const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** Collapses text to a comparable form: lowercase, no accents/punctuation,
 * single spaces. */
export function normalizeGuess(input: string): string {
    return input
        .toLowerCase()
        .normalize("NFKD")
        .replace(COMBINING_MARKS, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Common function words carry no guessing signal ("a cat on a mat" vs "the
// cat sits on the mat" should both credit "cat" and "mat"), so they're
// dropped before comparing.
const STOPWORDS = new Set([
    "a", "an", "the", "of", "in", "on", "at", "by", "to", "for", "with", "and",
    "or", "is", "are", "be", "as", "it", "its", "near", "under", "over", "up",
    "down", "out", "into", "onto", "from", "that", "this", "some", "few",
    "very", "their", "his", "her", "your", "my", "our",
]);

/** Very rough plural/verb-ending stemmer — enough to match "leaf"/"leaves"
 * or "runs"/"running" style variants without pulling in a stemming library. */
function stem(word: string): string {
    if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
    return word;
}

function significantWords(normalized: string): Set<string> {
    return new Set(
        normalized
            .split(" ")
            .filter((word) => word.length > 0 && !STOPWORDS.has(word))
            .map(stem),
    );
}

/** How much of the answer's key words a guess needs to cover to count as
 * correct. Loose on purpose — this is a party game, not a spelling test. */
const MATCH_THRESHOLD = 0.35;

/**
 * A guess is correct if it's an exact match after normalizing, or if it
 * covers most of the answer's significant (non-stopword) words — so word
 * order, articles, minor typos in unrelated words, and small
 * plural/tense differences don't fail an otherwise-right guess.
 */
export function isGuessCorrect(guess: string, answer: string): boolean {
    const normalizedGuess = normalizeGuess(guess);
    const normalizedAnswer = normalizeGuess(answer);
    if (!normalizedGuess) return false;
    if (normalizedGuess === normalizedAnswer) return true;

    const answerWords = significantWords(normalizedAnswer);
    if (answerWords.size === 0) return false;

    const guessWords = significantWords(normalizedGuess);
    const overlap = [...answerWords].filter((word) => guessWords.has(word)).length;

    return overlap / answerWords.size >= MATCH_THRESHOLD;
}
