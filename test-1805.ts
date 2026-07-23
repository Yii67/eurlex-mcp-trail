import { CellarClient } from './src/services/cellarClient.js';

const client = new CellarClient();
const celexId = '32023R1805';

try {
  const html = await client.fetchDocument(celexId, 'ENG');
  console.log(`✅ Document fetched: ${html.length} characters`);

  const plainText = html.replace(/<[^>]+>/g, ' ');

  const dates = ['2023-10-12', '2024-06-30', '2024-09-23', '2025-12-31', '2027-12-31', '2033-12-31'];
  for (const iso of dates) {
    const [y, m, d] = iso.split('-').map(Number);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const human = `${d} ${months[m-1]} ${y}`;
    const idx = plainText.indexOf(human);
    console.log(`${iso} -> "${human}" -> found at index: ${idx}`);

    // Also try without leading zero-padding weirdness, and a "1 January" style check
    if (idx === -1) {
      // try searching just for the year near "Article" to see what format IS used
      const yearIdx = plainText.indexOf(String(y));
      console.log(`   (year "${y}" alone first appears at index: ${yearIdx})`);
    }
  }
} catch (e) {
  console.log(`❌ Document fetch failed:`, e.message);
}
