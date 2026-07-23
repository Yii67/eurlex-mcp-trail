import { CellarClient } from './src/services/cellarClient.js';

const client = new CellarClient();
const html = await client.fetchDocument('32023R1805', 'ENG');
const plainText = html.replace(/<[^>]+>/g, ' ');

// Find "December 2033" (skip the day number, just anchor on month+year)
const idx = plainText.indexOf('December 2033');
console.log('found "December 2033" at:', idx);

if (idx !== -1) {
  // Look at the raw character codes right before "December"
  const before = plainText.slice(idx - 5, idx);
  console.log('Characters before "December":', JSON.stringify(before));
  console.log('Char codes:', [...before].map(c => c.charCodeAt(0)));
}
