import { CellarClient } from './src/services/cellarClient.js';

const client = new CellarClient();
const celexId = process.argv[2] || '32014R0050';

const result = await client.deadlinesQuery(celexId, 'ENG', true);
console.log(`\nTotal deadline entries: ${result.deadlines.length}`);

const html = await client.fetchDocument(celexId, 'ENG');
const plainText = html
  .replace(/<[^>]+>/g, ' ')
  .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ');

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Get the unique raw dates (dedupe since deadlinesQuery may already have split by article)
const uniqueDates = [...new Set(result.deadlines.map((d) => d.date))];

for (const iso of uniqueDates) {
  const matched = result.deadlines.filter((d) => d.date === iso && d.context !== null);
  const failed  = result.deadlines.filter((d) => d.date === iso && d.context === null);

  console.log(`\n=== ${iso} ===`);
  console.log(`  matched: ${matched.length}, failed: ${failed.length}`);

  if (failed.length > 0) {
    const [y, m, d] = iso.split('-').map(Number);
    const human = `${d} ${months[m - 1]} ${y}`;
    const idx = plainText.indexOf(human);
    console.log(`  Standard format "${human}" found at: ${idx}`);

    if (idx === -1) {
      // Try alternate formats commonly seen in EU legal text
      const alternates = [
        `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`, // 01.01.2015
        `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`, // 01/01/2015
        `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, // 2015-01-01
      ];
      for (const alt of alternates) {
        const altIdx = plainText.indexOf(alt);
        console.log(`  Alternate "${alt}" found at: ${altIdx}`);
      }

      // Show where the year alone appears, near any "Article" mentions, for manual inspection
      const yearIdx = plainText.indexOf(String(y));
      if (yearIdx !== -1) {
        console.log(`  Raw context around first "${y}" occurrence:`);
        console.log('  ' + plainText.slice(Math.max(0, yearIdx - 150), yearIdx + 50).replace(/\s+/g, ' '));
      }
    }
  }
}
