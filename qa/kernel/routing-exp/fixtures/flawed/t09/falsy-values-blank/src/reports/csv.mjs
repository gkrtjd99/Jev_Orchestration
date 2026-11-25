const cell = (value) => {
  const text = String(value || '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toCsv(rows, columns) {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  return lines.join('\n');
}
