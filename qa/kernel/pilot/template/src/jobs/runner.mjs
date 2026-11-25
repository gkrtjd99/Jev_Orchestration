// Runs every job whose interval has elapsed since it last ran. lastRun maps job name -> Date.
export async function runDue(jobs, { store, now, lastRun = new Map() }) {
  const ran = [];
  for (const job of jobs) {
    const previous = lastRun.get(job.name);
    const due = !previous || now.getTime() - previous.getTime() >= job.everyMinutes * 60 * 1000;
    if (!due) continue;
    const result = await job.run({ store, now });
    lastRun.set(job.name, now);
    ran.push({ name: job.name, result });
  }
  return ran;
}
