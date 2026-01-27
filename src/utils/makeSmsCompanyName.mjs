
export const makeSuSuProName = (companyName) => {
  if (!companyName || typeof companyName !== 'string') return 'SuSuPro';
  if(companyName === 'Big God Susu Enterprise') return 'BigGod Susu'
  // Get words (handles extra spaces, punctuation, hyphens)
  const words = companyName
    .trim()
    .split(/[\s\-_.]+/g)                // split on space, hyphen, underscore, dot
    .filter(Boolean);

  // Collect initials (letters only), uppercase
  const initials = words
    .map(w => (w.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/)?.[0] || '')) // first letter (incl. accents)
    .join('')
    .toUpperCase();

  return `${initials}SuSu`;
}