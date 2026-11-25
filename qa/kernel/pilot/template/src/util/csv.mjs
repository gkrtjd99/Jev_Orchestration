function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// columns: [{ key, header }]. Returns comma separated text with a header line.
export function toCsv(records, columns) {
  const lines = [columns.map((column) => cell(column.header)).join(',')];
  for (const record of records) lines.push(columns.map((column) => cell(record[column.key])).join(','));
  return lines.join('\n') + '\n';
}
