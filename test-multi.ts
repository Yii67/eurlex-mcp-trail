import { CellarClient } from './src/services/cellarClient.js';

const client = new CellarClient();

// Replace with the actual CELEX IDs that failed for you
const celexIds = ['32023R1805', '32017R0352', '32019R1239'];

for (const celex of celexIds) {
  console.log(`\n=== Testing ${celex} ===`);
  try {
    const result = await client.deadlinesQuery(celex, 'ENG', true);
    const withContext = result.deadlines.filter(d => d.context !== null).length;
    console.log(`✅ Success: ${result.deadlines.length} deadlines, ${withContext} with context`);
  } catch (e) {
    console.log(`❌ Failed:`, e.message);
  }
  // Small delay between calls, to see if timing matters
  await new Promise(r => setTimeout(r, 1000));
}
