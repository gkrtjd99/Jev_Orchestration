// Sequential ids, e.g. createIdGenerator('bk').next() -> 'bk-0001'.
export function createIdGenerator(prefix) {
  let counter = 0;
  return {
    next() {
      counter += 1;
      return `${prefix}-${String(counter).padStart(4, '0')}`;
    },
  };
}
