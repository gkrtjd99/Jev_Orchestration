const cell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text}"` : text;
};

export function toCsv(rows, columns) {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  return lines.join('\n');
}
