import { CellarClient } from './src/services/cellarClient.js';

const client = new CellarClient();
const celexId = '32017R0352';

// Step 1: Get deadlines (ISO format dates)
const deadlineData = await client.deadlinesQuery(celexId, 'ENG');
console.log('Deadlines from SPARQL:', JSON.stringify(deadlineData.deadlines, null, 2));

// Step 2: Convert ISO date (YYYY-MM-DD) to human-readable format (D Month YYYY)
function isoToHumanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December'];
  return `${day} ${months[month - 1]} ${year}`;
}

// Step 3: Fetch full document text
const html = await client.fetchDocument(celexId, 'ENG');
const plainText = html.replace(/<[^>]+>/g, ' ');
console.log(`\nFetched document: ${plainText.length} characters\n`);

// Step 4: For each deadline, find all occurrences and extract the nearest Article context
for (const deadline of deadlineData.deadlines) {
  const humanDate = isoToHumanDate(deadline.date);
  console.log(`\n=== Deadline: ${deadline.date} (searching for "${humanDate}") ===`);

  let searchFrom = 0;
  let occurrenceCount = 0;

  while (true) {
    const idx = plainText.indexOf(humanDate, searchFrom);
    if (idx === -1) break;
    occurrenceCount++;

    // Walk backward to find the nearest preceding "Article N" heading
    const textBefore = plainText.slice(0, idx);
    const articleMatches = [...textBefore.matchAll(/Article\s+(\d+)/g)];
    const nearestArticle = articleMatches.length > 0
      ? articleMatches[articleMatches.length - 1]
      : null;

    if (nearestArticle) {
      const articleNum = nearestArticle[1];
      const articleStart = nearestArticle.index!;
      // Find the next Article heading after this one, to bound the snippet
      const textAfterArticleStart = plainText.slice(articleStart);
      const nextArticleMatch = textAfterArticleStart.slice(20).match(/Article\s+\d+/);
      const articleEnd = nextArticleMatch
        ? articleStart + 20 + nextArticleMatch.index!
        : Math.min(articleStart + 1500, plainText.length);

      const snippet = plainText.slice(articleStart, articleEnd)
        .replace(/\s+/g, ' ')
        .trim();

      console.log(`\nOccurrence ${occurrenceCount} — Article ${articleNum}:`);
      console.log(snippet.slice(0, 400) + (snippet.length > 400 ? '...' : ''));
    } else {
      console.log(`\nOccurrence ${occurrenceCount} — no preceding Article found`);
    }

    searchFrom = idx + humanDate.length;
  }

  if (occurrenceCount === 0) {
    console.log('No occurrences found in document text.');
  }
}
