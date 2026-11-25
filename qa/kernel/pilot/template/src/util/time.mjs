const toDate = (value) => (value instanceof Date ? value : new Date(value));

export function secondsBetween(from, to) {
  return (toDate(to).getTime() - toDate(from).getTime()) / 1000;
}

export function daysBetween(from, to) {
  return secondsBetween(from, to) / 86400;
}

export function addHours(from, hours) {
  return new Date(toDate(from).getTime() + hours * 3600 * 1000);
}

export function sameUtcDay(a, b) {
  return toDate(a).toISOString().slice(0, 10) === toDate(b).toISOString().slice(0, 10);
}
