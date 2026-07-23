import { CellarClient } from './src/services/cellarClient.js';

const client = new CellarClient();
const result = await client.deadlinesQuery('32017L2110', 'ENG', true);
console.log(JSON.stringify(result, null, 2));
