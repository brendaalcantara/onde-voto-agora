export const EXPECTED_HEADERS = Object.freeze([
  "aa_eleicao",
  "nm_pais",
  "sg_uf",
  "nm_municipio",
  "nr_zona",
  "nm_local_votacao_inicial",
  "nr_secao",
  "nm_local_votacao_final",
  "qt_eleitores",
]);

export function parseSemicolonCsv(source) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (insideQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell.length === 0) {
      insideQuotes = true;
    } else if (character === ";") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      row.push(cell);
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      cell = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else {
      cell += character;
    }
  }

  if (insideQuotes) throw new Error("O CSV termina dentro de um campo entre aspas.");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }

  if (rows.length === 0) return [];
  rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleUpperCase("pt-BR")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeNumber(value) {
  const digits = String(value ?? "").trim();
  return /^\d+$/.test(digits) ? digits.replace(/^0+(?=\d)/, "") : digits;
}

export function validateCsv(csvText, sourceName = "CSV") {
  let rows;
  try {
    rows = parseSemicolonCsv(csvText);
  } catch (error) {
    return {
      headers: [],
      records: [],
      errors: [{ line: 1, message: `${sourceName}: ${error.message}` }],
      duplicateKeys: [],
      totalDataRows: 0,
    };
  }

  const headers = rows.shift() ?? [];
  const errors = [];
  const duplicateKeys = [];
  const records = [];
  const headersMatch = headers.length === EXPECTED_HEADERS.length && headers.every((header, index) => header === EXPECTED_HEADERS[index]);
  if (!headersMatch) {
    return {
      headers,
      records,
      errors: [{ line: 1, message: `${sourceName}: cabeçalho diferente do formato esperado pelo TSE.` }],
      duplicateKeys,
      totalDataRows: rows.length,
    };
  }

  const seen = new Set();
  for (const [index, rawRow] of rows.entries()) {
    const line = index + 2;
    if (rawRow.length !== EXPECTED_HEADERS.length) {
      errors.push({ line, message: `Esperadas ${EXPECTED_HEADERS.length} colunas; encontradas ${rawRow.length}.` });
      continue;
    }

    const row = rawRow.map((value) => value.trim());
    const [eleicao, pais, uf, municipio, zona, localInicial, secao, localFinal, eleitores] = row;
    const record = { eleicao, pais, uf, municipio, zona, localInicial, secao, localFinal, eleitores };
    const missingFields = [];
    if (!/^\d{4}$/.test(eleicao)) missingFields.push("eleição");
    if (!pais) missingFields.push("país");
    if (!/^[A-Za-z]{2}$/.test(uf)) missingFields.push("UF");
    if (!municipio) missingFields.push("município");
    if (!/^\d+$/.test(zona)) missingFields.push("zona");
    if (!localInicial) missingFields.push("local antigo");
    if (!/^\d+$/.test(secao)) missingFields.push("seção");
    if (!localFinal) missingFields.push("local novo");
    if (!/^\d+$/.test(eleitores)) missingFields.push("eleitorado");
    if (missingFields.length > 0) errors.push({ line, message: `Campo obrigatório ausente ou inválido: ${missingFields.join(", ")}.` });

    const key = recordKey(record);
    if (seen.has(key)) duplicateKeys.push({ line, key, record });
    seen.add(key);
    records.push(record);
  }

  for (const duplicate of duplicateKeys) {
    errors.push({ line: duplicate.line, message: `Chave de seção duplicada: ${duplicate.record.uf}/${duplicate.record.municipio}/${duplicate.record.zona}/${duplicate.record.secao}.` });
  }

  return { headers, records, errors, duplicateKeys, totalDataRows: rows.length };
}

export function recordKey(record) {
  return [
    String(record.eleicao ?? "").trim(),
    normalizeText(record.uf),
    normalizeText(record.municipio),
    normalizeNumber(record.zona),
    normalizeNumber(record.secao),
  ].join("\u0000");
}

export function filterRecords(records, filters) {
  const state = normalizeText(filters.estado);
  const city = normalizeText(filters.cidade);
  const section = normalizeNumber(filters.secao);
  const oldPlace = normalizeText(filters.localAntigo);
  const voters = normalizeNumber(filters.eleitorado);

  return records.filter((record) =>
    (!state || normalizeText(record.uf) === state) &&
    (!city || normalizeText(record.municipio).includes(city)) &&
    (!section || normalizeNumber(record.secao) === section) &&
    (!oldPlace || normalizeText(record.localInicial).includes(oldPlace)) &&
    (!voters || normalizeNumber(record.eleitores) === voters)
  );
}

export function reconcileRecords(baseRecords, officialRecords) {
  const baseByKey = new Map(baseRecords.map((record) => [recordKey(record), record]));
  const officialByKey = new Map(officialRecords.map((record) => [recordKey(record), record]));
  const inclusoesNaBase = [];
  const faltantesNaBase = [];
  const ausentesNaFonteAtual = [];
  const alteracoes = [];
  const fields = [
    ["pais", "país"],
    ["uf", "UF"],
    ["municipio", "município"],
    ["zona", "zona"],
    ["localInicial", "local antigo"],
    ["secao", "seção"],
    ["localFinal", "local novo"],
    ["eleitores", "eleitorado"],
  ];

  for (const [key, official] of officialByKey) {
    const local = baseByKey.get(key);
    if (!local) {
      faltantesNaBase.push(official);
      inclusoesNaBase.push(official);
      continue;
    }
    const differences = fields
      .filter(([field]) => String(local[field] ?? "").trim() !== String(official[field] ?? "").trim())
      .map(([field, label]) => ({ campo: label, local: local[field], oficial: official[field] }));
    if (differences.length > 0) alteracoes.push({ chave: key, local, oficial: official, campos: differences });
  }

  for (const [key, local] of baseByKey) {
    if (!officialByKey.has(key)) ausentesNaFonteAtual.push(local);
  }

  return {
    reconciliada: inclusoesNaBase.length === 0 && ausentesNaFonteAtual.length === 0 && alteracoes.length === 0,
    inclusoesNaBase,
    faltantesNaBase,
    ausentesNaFonteAtual,
    alteracoes,
  };
}
