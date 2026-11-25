// Which paths each task may touch. Used to report changes that belong to no task (check.mjs) and
// writes by a subagent outside its own task (analyze.mjs). A scope entry ending in "/" is a folder prefix.
export const COMMON_SCOPE = ['test/', 'docs/', 'README.md'];

export const TASK_SCOPE = {
  t01: ['src/reports/'],
  t02: ['src/config/', 'src/lockers/door-watch.mjs', 'src/jobs/door-watch-sweep.mjs', 'src/main.mjs', '.env.example'],
  t03: ['src/util/tracking.mjs'],
  t04: ['src/jobs/', 'ops/'],
  t05: ['src/lockers/assign.mjs', 'src/errors.mjs', 'src/faults/'],
  t06: ['src/http/'],
  t07: ['src/util/phone.mjs'],
  t08: ['src/notify/'],
};

const matches = (rel, entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry);

export function inScope(rel, taskId) {
  return [...(TASK_SCOPE[taskId] ?? []), ...COMMON_SCOPE].some((entry) => matches(rel, entry));
}

export function inAnyScope(rel) {
  return COMMON_SCOPE.some((entry) => matches(rel, entry))
    || Object.values(TASK_SCOPE).some((entries) => entries.some((entry) => matches(rel, entry)));
}
