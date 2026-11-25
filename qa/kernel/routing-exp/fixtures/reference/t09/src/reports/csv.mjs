const cell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** rows: objects, columns: keys to export. Header line first, lines joined by '\n', no trailing newline. */
export function toCsv(rows, columns) {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  return lines.join('\n');
}
