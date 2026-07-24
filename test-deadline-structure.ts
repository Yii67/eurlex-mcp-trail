import { SPARQL_ENDPOINT } from './src/constants.js';

async function runSparql(query: string) {
  const response = await fetch(SPARQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: query,
  });
  return response.json();
}

const celexId = '32022R1925';

const typeCheck = await runSparql(`
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?deadline (isLiteral(?deadline) AS ?isLiteral) (isURI(?deadline) AS ?isUri) (isBlank(?deadline) AS ?isBlank) WHERE {
  ?work cdm:resource_legal_id_celex ?celexVal .
  FILTER(STR(?celexVal) = "${celexId}")
  ?work cdm:resource_legal_date_deadline ?deadline .
}
`);
console.log('=== Deadline value types ===');
console.log(JSON.stringify(typeCheck, null, 2));

const propsCheck = await runSparql(`
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?deadline ?p ?o WHERE {
  ?work cdm:resource_legal_id_celex ?celexVal .
  FILTER(STR(?celexVal) = "${celexId}")
  ?work cdm:resource_legal_date_deadline ?deadline .
  ?deadline ?p ?o .
}
`);
console.log('\n=== Properties attached to deadline nodes ===');
console.log(JSON.stringify(propsCheck, null, 2));
