import {
  SPARQL_ENDPOINT,
  CELLAR_REST_BASE,
  EURLEX_BASE,
  DEFAULT_LANGUAGE,
  DEFAULT_LIMIT,
  REQUEST_TIMEOUT_MS,
} from '../constants.js';
import type {
  SparqlQueryParams,
  SearchResult,
  MetadataResult,
  CitationsResult,
  CitationEntry,
} from '../types.js';

/** Maps 3-letter language codes to CDM expression language URI suffixes */
const LANGUAGE_URI_MAP: Record<string, string> = {
  DEU: 'DEU',
  ENG: 'ENG',
  FRA: 'FRA',
};

/** Maps 3-letter language codes to HTTP Accept-Language values */
const LANGUAGE_HTTP_MAP: Record<string, string> = {
  DEU: 'de',
  ENG: 'en',
  FRA: 'fr',
};

/** Valid citation relationship types between EU legal acts */
export const VALID_RELATIONSHIPS = new Set<CitationEntry['relationship']>([
  'cites',
  'cited_by',
  'amends',
  'amended_by',
  'based_on',
  'basis_for',
  'repeals',
  'repealed_by',
]);

/** Shape of a single SPARQL binding value */
interface SparqlBindingValue {
  type: string;
  value: string;
}

/** Shape of the metadata SPARQL JSON results */
interface MetadataSparqlResponse {
  results: {
    bindings: {
      title?: SparqlBindingValue;
      dateDoc?: SparqlBindingValue;
      dateForce?: SparqlBindingValue;
      dateEnd?: SparqlBindingValue;
      inForce?: SparqlBindingValue;
      dateTrans?: SparqlBindingValue;
      resType?: SparqlBindingValue;
      authors?: SparqlBindingValue;
      eurovoc?: SparqlBindingValue;
      dirCodes?: SparqlBindingValue;
    }[];
  };
}

/** Shape of the citations SPARQL JSON results */
interface CitationsSparqlResponse {
  results: {
    bindings: {
      celex: SparqlBindingValue;
      title: SparqlBindingValue;
      date?: SparqlBindingValue;
      resType: SparqlBindingValue;
      rel: SparqlBindingValue;
    }[];
  };
}

/** Shape of the SPARQL JSON results */
interface SparqlResponse {
  results: {
    bindings: {
      work: SparqlBindingValue;
      celex: SparqlBindingValue;
      title: SparqlBindingValue;
      date?: SparqlBindingValue;
      resType: SparqlBindingValue;
    }[];
  };
}

/** Shape of the deadlines SPARQL JSON results */
interface DeadlinesSparqlResponse {
  results: {
    bindings: {
      dateForce?: SparqlBindingValue;
      dateTrans?: SparqlBindingValue;
      deadline?: SparqlBindingValue;
      deadlineComment?: SparqlBindingValue;
    }[];
  };
}

/** A single resolved compliance deadline, enriched with article context */
export interface DeadlineEntry {
  date: string; // ISO date, e.g. "2019-03-24"
  comment: string; // original rdfs:comment from SPARQL (usually empty)
  article_ref: string | null; // e.g. "Article 20", or null if no article found
  context: string | null; // extracted raw article text, or null if not found
}

/**
 * Escapes a string for safe inclusion in a SPARQL literal.
 * Escapes backslashes and double-quotes.
 */
export function escapeSparqlString(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '');
}

/**
 * Converts an ISO date (YYYY-MM-DD) into the human-readable format
 * used in EUR-Lex document text, e.g. "2019-03-24" -> "24 March 2019".
 */
export function isoToHumanDate(isoDate: string): string | null {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [year, month, day] = parts;
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  if (month < 1 || month > 12) return null;
  return `${day} ${months[month - 1]} ${year}`;
}

/**
 * Given the full plain-text of a legal document and a target date
 * (in human-readable form, e.g. "24 March 2019"), finds every
 * occurrence of that date and extracts the nearest preceding
 * "Article N" heading plus the text up to the next Article heading.
 *
 * Returns one entry per occurrence, since the same date can appear
 * under multiple distinct articles (e.g. two separate obligations
 * that both fall due on the same date).
 */
export function extractArticleContexts(
  plainText: string,
  humanDate: string,
  maxSnippetLength = 500,
): { article_ref: string; context: string }[] {
  const results: { article_ref: string; context: string }[] = [];
  let searchFrom = 0;

  while (true) {
    const idx = plainText.indexOf(humanDate, searchFrom);
    if (idx === -1) break;

    const textBefore = plainText.slice(0, idx);
    const articleMatches = [...textBefore.matchAll(/Article\s+(\d+)/g)];
    const nearestArticle =
      articleMatches.length > 0 ? articleMatches[articleMatches.length - 1] : null;

    if (nearestArticle && typeof nearestArticle.index === 'number') {
      const articleNum = nearestArticle[1];
      const articleStart = nearestArticle.index;

      // Find the next "Article N" heading after this one, to bound the snippet.
      const textAfterArticleStart = plainText.slice(articleStart);
      const nextArticleMatch = textAfterArticleStart.slice(20).match(/Article\s+\d+/);
      const articleEnd =
        nextArticleMatch && typeof nextArticleMatch.index === 'number'
          ? articleStart + 20 + nextArticleMatch.index
          : Math.min(articleStart + maxSnippetLength * 3, plainText.length);

      const rawSnippet = plainText.slice(articleStart, articleEnd).replace(/\s+/g, ' ').trim();
      const snippet =
        rawSnippet.length > maxSnippetLength
          ? rawSnippet.slice(0, maxSnippetLength) + '...'
          : rawSnippet;

      const isDuplicate = results.some(
        (r) => r.article_ref === `Article ${articleNum}` && r.context === snippet,
      );
      if (!isDuplicate) {
        results.push({ article_ref: `Article ${articleNum}`, context: snippet });
      }
    }

    searchFrom = idx + humanDate.length;
  }

  return results;
}

export class CellarClient {
  private async executeSparql<T>(sparql: string): Promise<T> {
    const response = await fetch(SPARQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: sparql,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`SPARQL endpoint error: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Builds a SPARQL SELECT query from the given parameters.
   */
  buildSparqlQuery(params: SparqlQueryParams): string {
    const lang = LANGUAGE_URI_MAP[params.language] ?? params.language;
    const escaped = escapeSparqlString(params.query);

    const whereLines: string[] = [];

    // Resource type filter
    if (params.resource_type !== 'any') {
      whereLines.push(
        `    ?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/${params.resource_type}> .`,
      );
    }

    // Always bind the resource type
    whereLines.push(
      '    ?work cdm:work_has_resource-type ?resTypeUri .',
      '    BIND(REPLACE(STR(?resTypeUri), "^.*/", "") AS ?resType)',
    );

    // CELEX identifier
    whereLines.push('    OPTIONAL { ?work cdm:resource_legal_id_celex ?celex . }');
    whereLines.push('    OPTIONAL { ?work cdm:work_id_document ?celex . }');
    whereLines.push('    FILTER(BOUND(?celex))');

    // Expression and title (REQUIRED, not optional)
    whereLines.push(
      `    ?expr cdm:expression_belongs_to_work ?work .`,
      `    ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${lang}> .`,
    );
    whereLines.push('    {');
    whereLines.push('      { ?expr cdm:expression_title ?title . }');
    whereLines.push('      UNION');
    whereLines.push('      { ?work cdm:work_title ?title . }');
    whereLines.push('    }');

    // Date is OPTIONAL
    whereLines.push('    OPTIONAL { ?work cdm:work_date_document ?date . }');

    // Search filter on title
    whereLines.push(`    FILTER(CONTAINS(LCASE(STR(?title)), LCASE("${escaped}")))`);

    // Date filters
    if (params.date_from) {
      whereLines.push(`    FILTER(?date >= "${params.date_from}"^^xsd:date)`);
    }
    if (params.date_to) {
      whereLines.push(`    FILTER(?date <= "${params.date_to}"^^xsd:date)`);
    }

    const query = [
      'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>',
      'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
      '',
      'SELECT DISTINCT ?work ?celex ?title ?date ?resType WHERE {',
      ...whereLines,
      '}',
      `ORDER BY DESC(?date)`,
      `LIMIT ${params.limit}`,
    ].join('\n');

    return query;
  }

  /**
   * Executes a SPARQL query against the EU Publications Office endpoint.
   * Merges provided params with defaults before building and executing the query.
   */
  async sparqlQuery(
    query: string,
    params?: Partial<SparqlQueryParams>,
  ): Promise<{ results: SearchResult[]; sparql: string }> {
    const fullParams: SparqlQueryParams = {
      query,
      resource_type: params?.resource_type ?? 'any',
      language: params?.language ?? DEFAULT_LANGUAGE,
      limit: params?.limit ?? DEFAULT_LIMIT,
      date_from: params?.date_from,
      date_to: params?.date_to,
    };

    const sparql = this.buildSparqlQuery(fullParams);

    const data = await this.executeSparql<SparqlResponse>(sparql);
    const lang = fullParams.language;

    const results = data.results.bindings.map((binding) => {
      const celex = binding.celex.value;
      return {
        celex,
        title: binding.title.value,
        date: binding.date?.value ?? '',
        type: binding.resType.value,
        eurlex_url: `${EURLEX_BASE}/${LANGUAGE_HTTP_MAP[lang] ?? 'en'}/TXT/?uri=CELEX:${celex}`,
      };
    });

    // Deduplicate by CELEX ID (same document can have multiple resource types)
    const seen = new Set<string>();
    const deduped = results.filter((r) => {
      if (seen.has(r.celex)) return false;
      seen.add(r.celex);
      return true;
    });

    return { results: deduped, sparql };
  }

  /**
   * Fetches a document from Cellar by CELEX identifier using content negotiation.
   * Uses Accept-Language header to select the language variant.
   */
  async fetchDocument(celex_id: string, language: string): Promise<string> {
    const httpLang = LANGUAGE_HTTP_MAP[language] ?? 'en';
    const url = `${CELLAR_REST_BASE}/${celex_id}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/xhtml+xml',
        'Accept-Language': httpLang,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 404) {
      throw new Error(
        `Document not found: ${celex_id}. The document may not be available in electronic full-text format on EUR-Lex.`,
      );
    }

    if (response.status === 406) {
      throw new Error(
        `Document ${celex_id} is not available in XHTML format. Older documents may only exist as PDF on EUR-Lex.`,
      );
    }

    if (!response.ok) {
      throw new Error(`Fetch error: ${response.status}`);
    }

    return response.text();
  }

  /**
   * Builds a SPARQL query to retrieve metadata for a given CELEX ID.
   * Language defaults to ENG — EuroVoc labels are returned in the requested language.
   */
  buildMetadataQuery(celexId: string, language: string): string {
    const lang = LANGUAGE_URI_MAP[language] ?? language;
    const langLower = LANGUAGE_HTTP_MAP[language] ?? 'en'; // ← was 'de', now 'en'

    const query = [
      'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>',
      'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>',
      'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
      '',
      'SELECT ?title ?dateDoc ?dateForce ?dateEnd ?inForce ?dateTrans ?resType',
      '  (GROUP_CONCAT(DISTINCT ?authorName; separator="|||") AS ?authors)',
      '  (GROUP_CONCAT(DISTINCT ?evLabel; separator="|||") AS ?eurovoc)',
      '  (GROUP_CONCAT(DISTINCT ?dirCode; separator="|||") AS ?dirCodes)',
      'WHERE {',
      `  ?work cdm:resource_legal_id_celex ?celexVal .`,
      `  FILTER(STR(?celexVal) = "${escapeSparqlString(celexId)}")`,
      `  ?expr cdm:expression_belongs_to_work ?work .`,
      `  ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${lang}> .`,
      `  ?expr cdm:expression_title ?title .`,
      '  OPTIONAL { ?work cdm:work_date_document ?dateDoc . }',
      '  OPTIONAL { ?work cdm:resource_legal_date_entry-into-force ?dateForce . }',
      '  OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?dateEnd . }',
      '  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce . }',
      '  OPTIONAL { ?work cdm:resource_legal_date_transposition ?dateTrans . }',
      '  OPTIONAL {',
      '    ?work cdm:work_has_resource-type ?resTypeUri .',
      '    BIND(REPLACE(STR(?resTypeUri), "^.*/", "") AS ?resType)',
      '  }',
      '  OPTIONAL {',
      '    ?work cdm:work_created_by_agent ?agent .',
      '    ?agent cdm:agent_name ?authorName .',
      '  }',
      '  OPTIONAL {',
      '    ?work cdm:work_is_about_concept_eurovoc ?evConcept .',
      '    ?evConcept skos:prefLabel ?evLabel .',
      `    FILTER(LANG(?evLabel) = "${langLower}")`, // ← now 'en' when ENG passed
      '  }',
      '  OPTIONAL {',
      '    ?work cdm:resource_legal_is_about_concept_directory-code ?dirCode .',
      '  }',
      '}',
      'GROUP BY ?title ?dateDoc ?dateForce ?dateEnd ?inForce ?dateTrans ?resType',
    ].join('\n');

    return query;
  }

  /**
   * Fetches metadata for a CELEX ID from the SPARQL endpoint.
   */
  async metadataQuery(celexId: string, language: string): Promise<MetadataResult> {
    const sparql = this.buildMetadataQuery(celexId, language);

    const data = await this.executeSparql<MetadataSparqlResponse>(sparql);

    if (data.results.bindings.length === 0) {
      throw new Error(`No metadata found for CELEX: ${celexId}`);
    }

    const binding = data.results.bindings[0];
    const httpLang = LANGUAGE_HTTP_MAP[language] ?? 'en';

    const splitConcat = (value: string | undefined): string[] => {
      if (!value) return [];
      return value.split('|||').filter((s) => s !== '');
    };

    const parseInForce = (value: string | undefined): boolean | null => {
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      return null;
    };

    return {
      celex_id: celexId,
      title: binding.title?.value ?? '',
      date_document: binding.dateDoc?.value ?? '',
      date_entry_into_force: binding.dateForce?.value ?? '',
      date_end_of_validity: binding.dateEnd?.value ?? '',
      in_force: parseInForce(binding.inForce?.value),
      date_transposition: binding.dateTrans?.value ?? '',
      resource_type: binding.resType?.value ?? '',
      authors: splitConcat(binding.authors?.value),
      eurovoc_concepts: splitConcat(binding.eurovoc?.value),
      directory_codes: splitConcat(binding.dirCodes?.value),
      eurlex_url: `${EURLEX_BASE}/${httpLang}/TXT/?uri=CELEX:${celexId}`,
    };
  }

  /**
   * Builds a SPARQL query to retrieve citations/relationships for a given CELEX ID.
   */
  buildCitationsQuery(
    celexId: string,
    language: string,
    direction: 'cites' | 'cited_by' | 'both',
    limit: number,
  ): string {
    const lang = LANGUAGE_URI_MAP[language] ?? language;
    const escaped = escapeSparqlString(celexId);

    const sourceFilter = `    ?sourceWork cdm:resource_legal_id_celex ?srcCelex .\n    FILTER(STR(?srcCelex) = "${escaped}")`;

    const citesBlock = [
      '  {',
      sourceFilter,
      '    { ?sourceWork cdm:work_cites_work ?relWork . BIND("cites" AS ?rel) }',
      '    UNION',
      '    { ?sourceWork cdm:resource_legal_based_on_resource_legal ?relWork . BIND("based_on" AS ?rel) }',
      '    UNION',
      '    { ?sourceWork cdm:resource_legal_amends_resource_legal ?relWork . BIND("amends" AS ?rel) }',
      '    UNION',
      '    { ?sourceWork cdm:resource_legal_repeals_resource_legal ?relWork . BIND("repeals" AS ?rel) }',
      '  }',
    ].join('\n');

    const citedByBlock = [
      '  {',
      `    ?relWork cdm:work_cites_work ?sourceWork .`,
      sourceFilter,
      '    BIND("cited_by" AS ?rel)',
      '  }',
      '  UNION',
      '  {',
      `    ?relWork cdm:resource_legal_based_on_resource_legal ?sourceWork .`,
      sourceFilter,
      '    BIND("basis_for" AS ?rel)',
      '  }',
      '  UNION',
      '  {',
      `    ?relWork cdm:resource_legal_amends_resource_legal ?sourceWork .`,
      sourceFilter,
      '    BIND("amended_by" AS ?rel)',
      '  }',
      '  UNION',
      '  {',
      `    ?relWork cdm:resource_legal_repeals_resource_legal ?sourceWork .`,
      sourceFilter,
      '    BIND("repealed_by" AS ?rel)',
      '  }',
    ].join('\n');

    let body: string;
    if (direction === 'cites') body = citesBlock;
    else if (direction === 'cited_by') body = citedByBlock;
    else body = `${citesBlock}\n  UNION\n${citedByBlock}`;

    return [
      'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>',
      '',
      'SELECT DISTINCT ?celex ?title ?date ?resType ?rel WHERE {',
      body,
      '  ?relWork cdm:resource_legal_id_celex ?celex .',
      '  ?relWork cdm:work_has_resource-type ?resTypeUri .',
      '  BIND(REPLACE(STR(?resTypeUri), "^.*/", "") AS ?resType)',
      `  ?relExpr cdm:expression_belongs_to_work ?relWork .`,
      `  ?relExpr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${lang}> .`,
      '  ?relExpr cdm:expression_title ?title .',
      '  OPTIONAL { ?relWork cdm:work_date_document ?date . }',
      '}',
      'ORDER BY DESC(?date)',
      `LIMIT ${limit}`,
    ].join('\n');
  }

  /**
   * Fetches citations/relationships for a CELEX ID from the SPARQL endpoint.
   */
  async citationsQuery(
    celexId: string,
    language: string,
    direction: 'cites' | 'cited_by' | 'both',
    limit: number,
  ): Promise<CitationsResult> {
    const sparql = this.buildCitationsQuery(celexId, language, direction, limit);
    const httpLang = LANGUAGE_HTTP_MAP[language] ?? 'en';

    const data = await this.executeSparql<CitationsSparqlResponse>(sparql);

    const citations = data.results.bindings.map((b) => {
      const rel = b.rel.value;
      if (!VALID_RELATIONSHIPS.has(rel as CitationEntry['relationship'])) {
        throw new Error(`Unexpected relationship value from SPARQL: ${rel}`);
      }
      return {
        celex: b.celex.value,
        title: b.title.value,
        date: b.date?.value ?? '',
        type: b.resType.value,
        relationship: rel as CitationEntry['relationship'],
        eurlex_url: `${EURLEX_BASE}/${httpLang}/TXT/?uri=CELEX:${b.celex.value}`,
      };
    });

    return {
      celex_id: celexId,
      citations,
      total: citations.length,
    };
  }

  /**
   * Resolves a EuroVoc label to its concept URI via a lightweight SPARQL query.
   * Returns null if no matching concept is found.
   */
  async resolveEurovocLabel(label: string): Promise<string | null> {
    const sparql = [
      'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>',
      'SELECT ?concept WHERE {',
      '  ?concept a skos:Concept .',
      '  ?concept skos:prefLabel ?label .',
      `  FILTER(STRSTARTS(STR(?concept), "http://eurovoc.europa.eu/"))`,
      `  FILTER(CONTAINS(LCASE(STR(?label)), LCASE("${escapeSparqlString(label)}")))`,
      '}',
      'LIMIT 1',
    ].join('\n');

    try {
      const data = await this.executeSparql<{
        results: { bindings: { concept: { value: string } }[] };
      }>(sparql);
      const bindings = data.results.bindings;
      return bindings.length > 0 ? bindings[0].concept.value : null;
    } catch {
      return null;
    }
  }

  /**
   * Builds a SPARQL query to find EU legal acts by EuroVoc concept URI.
   */
  buildEurovocQuery(
    conceptUri: string,
    resourceType: string,
    language: string,
    limit: number,
  ): string {
    const lang = LANGUAGE_URI_MAP[language] ?? language;

    if (!conceptUri.startsWith('http')) {
      throw new Error(
        `Invalid concept: expected a URI starting with http, got "${conceptUri}". Use resolveEurovocLabel() first.`,
      );
    }
    if (/[<>]/.test(conceptUri)) {
      throw new Error(`Invalid URI: contains characters not allowed in SPARQL IRIs`);
    }
    if (/[\s"{}|\\^`]/.test(conceptUri)) {
      throw new Error(`Invalid URI: contains characters not allowed in SPARQL IRIs`);
    }

    const conceptFilter = `  ?work cdm:work_is_about_concept_eurovoc <${conceptUri}> .`;
    const typeFilter =
      resourceType !== 'any'
        ? `  ?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/${resourceType}> .`
        : '';

    return [
      'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>',
      'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>',
      'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
      '',
      'SELECT DISTINCT ?work ?celex ?title ?date ?resType WHERE {',
      conceptFilter,
      typeFilter,
      '  ?work cdm:resource_legal_id_celex ?celex .',
      '  ?work cdm:work_has_resource-type ?resTypeUri .',
      '  BIND(REPLACE(STR(?resTypeUri), "^.*/", "") AS ?resType)',
      `  ?expr cdm:expression_belongs_to_work ?work .`,
      `  ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${lang}> .`,
      '  ?expr cdm:expression_title ?title .',
      '  OPTIONAL { ?work cdm:work_date_document ?date . }',
      `  FILTER NOT EXISTS { ?work cdm:do_not_index "true"^^xsd:boolean }`,
      '}',
      'ORDER BY DESC(?date)',
      `LIMIT ${limit}`,
    ].join('\n');
  }

  /**
   * Executes a EuroVoc concept query against the SPARQL endpoint.
   */
  async eurovocQuery(
    concept: string,
    resourceType: string,
    language: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const isUri = concept.startsWith('http');
    let conceptUri: string;

    if (isUri) {
      conceptUri = concept;
    } else {
      const resolved = await this.resolveEurovocLabel(concept);
      if (resolved === null) return [];
      conceptUri = resolved;
    }

    const sparql = this.buildEurovocQuery(conceptUri, resourceType, language, limit);
    const httpLang = LANGUAGE_HTTP_MAP[language] ?? 'en';

    const data = await this.executeSparql<SparqlResponse>(sparql);
    return data.results.bindings.map((b) => ({
      celex: b.celex.value,
      title: b.title.value,
      date: b.date?.value ?? '',
      type: b.resType.value,
      eurlex_url: `${EURLEX_BASE}/${httpLang}/TXT/?uri=CELEX:${b.celex.value}`,
    }));
  }

  /** Maps doc_type (reg/dir/dec) to CELEX type letter (R/L/D) */
  private static readonly DOC_TYPE_CELEX_MAP: Record<string, string> = {
    reg: 'R',
    dir: 'L',
    dec: 'D',
  };

  /**
   * Finds the consolidated CELEX ID for a given document via SPARQL.
   */
  async findConsolidatedCelex(
    docType: string,
    year: number,
    number: number,
  ): Promise<string | null> {
    const typeLetter = CellarClient.DOC_TYPE_CELEX_MAP[docType] ?? 'R';
    const celexPrefix = `0${year}${typeLetter}${String(number).padStart(4, '0')}`;

    const sparql = [
      'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>',
      `SELECT ?celex WHERE {`,
      `  ?work cdm:resource_legal_id_celex ?celex .`,
      `  FILTER(STRSTARTS(STR(?celex), "${celexPrefix}"))`,
      `}`,
      `ORDER BY DESC(?celex)`,
      `LIMIT 1`,
    ].join('\n');

    const data = await this.executeSparql<{
      results: { bindings: { celex: { value: string } }[] };
    }>(sparql);
    return data.results.bindings.length > 0 ? data.results.bindings[0].celex.value : null;
  }

  /**
   * Fetches the consolidated version of an EU legal act.
   */
  async fetchConsolidated(
    docType: string,
    year: number,
    number: number,
    language: string,
  ): Promise<{ content: string; eliUrl: string }> {
    const consolidatedCelex = await this.findConsolidatedCelex(docType, year, number);

    if (!consolidatedCelex) {
      throw new Error(
        `Keine konsolidierte Fassung für ${docType}/${year}/${number} verfügbar. ` +
          `Verwenden Sie eurlex_fetch mit der CELEX-ID für die Original-OJ-Version.`,
      );
    }

    const httpLang = LANGUAGE_HTTP_MAP[language] ?? 'en';
    const url = `${CELLAR_REST_BASE}/${consolidatedCelex}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/xhtml+xml',
        'Accept-Language': httpLang,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 404) {
      throw new Error(
        `Keine konsolidierte Fassung für ${docType}/${year}/${number} verfügbar (${consolidatedCelex} nicht abrufbar). ` +
          `Verwenden Sie eurlex_fetch mit der CELEX-ID für die Original-OJ-Version.`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Consolidated document error: ${docType}/${year}/${number} (HTTP ${response.status})`,
      );
    }

    const eliUrl = `http://data.europa.eu/eli/${docType}/${year}/${number}`;
    return { content: await response.text(), eliUrl };
  }

  /**
   * Builds a SPARQL query to retrieve all compliance deadlines for a CELEX ID.
   * Fetches entry into force, transposition deadline, and all application dates.
   */
  buildDeadlinesQuery(celexId: string): string {
    const escaped = escapeSparqlString(celexId);

    return [
      'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>',
      'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
      'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
      '',
      'SELECT DISTINCT ?dateForce ?dateTrans ?deadline ?deadlineComment WHERE {',
      `  ?work cdm:resource_legal_id_celex ?celexVal .`,
      `  FILTER(STR(?celexVal) = "${escaped}")`,
      '  OPTIONAL { ?work cdm:resource_legal_date_entry-into-force ?dateForce . }',
      '  OPTIONAL { ?work cdm:resource_legal_date_transposition ?dateTrans . }',
      '  OPTIONAL {',
      '    ?work cdm:resource_legal_date_deadline ?deadline .',
      '    OPTIONAL { ?deadline rdfs:comment ?deadlineComment . }',
      '  }',
      '}',
    ].join('\n');
  }

  /**
   * Fetches all compliance deadlines for a CELEX ID, enriched with the
   * article text each deadline actually refers to.
   *
   * For each deadline date returned by SPARQL, this fetches the full
   * document text once and searches for the human-readable form of
   * that date, extracting the nearest "Article N" context. If a date
   * appears under multiple distinct articles, each is returned as a
   * separate deadline entry.
   *
   * Falls back gracefully (article_ref/context = null) if the document
   * text can't be fetched or the date can't be located in it — the
   * bare date is still returned so the feature degrades, not breaks.
   *
   * @param includeContext When false (default), skips the document fetch
   *   and article-context extraction entirely — returns bare dates only,
   *   as fast as the original SPARQL-only version. Use this for list views
   *   showing many documents at once. Set to true only when resolving a
   *   single document's full deadline detail, where the extra fetch cost
   *   is worth it and won't compound across dozens of documents.
   */
  async deadlinesQuery(
    celexId: string,
    language: string,
    includeContext = false,
  ): Promise<{
    celex_id: string;
    date_entry_into_force: string;
    date_transposition: string;
    deadlines: DeadlineEntry[];
    eurlex_url: string;
  }> {
    const sparql = this.buildDeadlinesQuery(celexId);
    const httpLang = LANGUAGE_HTTP_MAP[language] ?? 'en';

    const data = await this.executeSparql<DeadlinesSparqlResponse>(sparql);
    const bindings = data.results.bindings;

    if (bindings.length === 0) {
      throw new Error(`No deadline data found for CELEX: ${celexId}`);
    }

    const first = bindings[0];
    const dateForce = first.dateForce?.value ?? '';
    const dateTrans = first.dateTrans?.value ?? '';

    // Collect all unique raw deadline dates first
    const seen = new Set<string>();
    const rawDeadlines: { date: string; comment: string }[] = [];

    for (const b of bindings) {
      if (b.deadline?.value && !seen.has(b.deadline.value)) {
        seen.add(b.deadline.value);
        rawDeadlines.push({
          date: b.deadline.value,
          comment: b.deadlineComment?.value ?? '',
        });
      }
    }

    // If there are no deadlines at all, skip the document fetch entirely.
    if (rawDeadlines.length === 0) {
      return {
        celex_id: celexId,
        date_entry_into_force: dateForce,
        date_transposition: dateTrans,
        deadlines: [],
        eurlex_url: `${EURLEX_BASE}/${httpLang}/TXT/?uri=CELEX:${celexId}`,
      };
    }

    // List-view mode: skip the document fetch entirely, return bare dates.
    if (!includeContext) {
      const bareDeadlines: DeadlineEntry[] = rawDeadlines
        .map((raw) => ({
          date: raw.date,
          comment: raw.comment,
          article_ref: null,
          context: null,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        celex_id: celexId,
        date_entry_into_force: dateForce,
        date_transposition: dateTrans,
        deadlines: bareDeadlines,
        eurlex_url: `${EURLEX_BASE}/${httpLang}/TXT/?uri=CELEX:${celexId}`,
      };
    }

    // Detail-view mode: fetch the document text once and resolve article context.
    let plainText: string | null = null;
    try {
      const html = await this.fetchDocument(celexId, language);
      plainText = html.replace(/<[^>]+>/g, ' ');
    } catch (err) {
      // TEMPORARY DEBUG LOGGING — remove once root cause is confirmed.
      console.error(`[deadlinesQuery] fetchDocument failed for ${celexId}:`, err);
      // If the document can't be fetched (e.g. PDF-only, 404), plainText
      // stays null (its initial value) and we return the bare dates below
      // with article_ref/context set to null.
    }

    const deadlines: DeadlineEntry[] = [];

    for (const raw of rawDeadlines) {
      const humanDate = isoToHumanDate(raw.date);

      if (!plainText || !humanDate) {
        deadlines.push({
          date: raw.date,
          comment: raw.comment,
          article_ref: null,
          context: null,
        });
        continue;
      }

      const contexts = extractArticleContexts(plainText, humanDate);

      if (contexts.length === 0) {
        // Date exists in metadata but wasn't found in the document text
        // (e.g. different date format used, or date only appears in an annex/table).
        deadlines.push({
          date: raw.date,
          comment: raw.comment,
          article_ref: null,
          context: null,
        });
      } else {
        // One deadline entry per distinct article that references this date.
        for (const ctx of contexts) {
          deadlines.push({
            date: raw.date,
            comment: raw.comment,
            article_ref: ctx.article_ref,
            context: ctx.context,
          });
        }
      }
    }

    deadlines.sort((a, b) => a.date.localeCompare(b.date));

    return {
      celex_id: celexId,
      date_entry_into_force: dateForce,
      date_transposition: dateTrans,
      deadlines,
      eurlex_url: `${EURLEX_BASE}/${httpLang}/TXT/?uri=CELEX:${celexId}`,
    };
  }
}
