/**
 * CSV for the files the page hands over.
 *
 * The exports joined values with bare commas, so a value holding a comma or
 * a quote would shift every column after it, and a value opening with = + @
 * would run as a formula when the file was opened in a spreadsheet. This is
 * the same cell rule the server's snapshot export uses.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // A spreadsheet runs a cell opening with = + @ or - as a formula; a
  // negative number is the one such opening that has to survive as is.
  if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d/.test(text))) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A dated name, so a second download is told apart from the first. */
export function csvFilename(basename, now = new Date()) {
  const slug = String(basename).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'tradegate'}-${now.toISOString().slice(0, 10)}.csv`;
}

export function downloadCsv(basename, header, rows) {
  const blob = new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = csvFilename(basename);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
