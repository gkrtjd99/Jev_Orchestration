#!/usr/bin/env node
// Offline dataset check: label agreement between the author gold and the blind labels for both suites.
// Sends nothing anywhere. Usage: node qa/kernel/dataset-agreement.mjs [--data dir] > dataset-agreement.json
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { loadSkillSuite, loadSupervisorSuite, skillAgreement, supervisorAgreement, OUTCOMES } from './lib/data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf('--data');
const dataDir = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(HERE, 'data'));

const names = new Set((await readdir(path.join(dataDir, 'skills'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name));
const skills = await loadSkillSuite(dataDir);
const supervisor = await loadSupervisorSuite(dataDir);
const key = set => [...set].sort().join('+');
const sup = supervisor.gold;
const out = {
  skills: {
    ...skillAgreement(skills, names), issues: skills.issues,
    disagreements: skills.items.filter(t => !skills.gold.consensus?.has(t.id))
      .map(t => ({ id: t.id, author: key(skills.gold.author.get(t.id) ?? []), blind: key(skills.gold.blind?.get(t.id) ?? []) })),
  },
  supervisor: {
    ...supervisorAgreement(supervisor), issues: supervisor.issues,
    consensusOutcomeCounts: sup.consensus ? Object.fromEntries(OUTCOMES.map(o => [o, [...sup.consensus.values()].filter(g => g.outcome === o).length])) : null,
    consensusWithEvidence: sup.consensus ? [...sup.consensus.values()].filter(g => g.evidence !== null).length : null,
    evidenceDisagreements: supervisor.items.filter(r => sup.blind?.has(r.id) && sup.author.get(r.id).evidence !== sup.blind.get(r.id).evidence)
      .map(r => ({ id: r.id, author: sup.author.get(r.id).evidence, blind: sup.blind.get(r.id).evidence })),
  },
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
