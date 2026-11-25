// Skill access classification for the outcome collector (src/collector.mjs). Pure functions, no IO.
//
// A subagent's tool calls are sorted into three kinds:
//   load           the call names one known project skill's SKILL.md with a reading tool AND its tool result
//                  came back without an error
//   indeterminate  the call may have read skill text, or named a skill file without clearly reading it, or
//                  would be a load but has no non-error result. Never a load and never a "did not load"
//   nothing        everything else
// One indeterminate call makes the whole transcript indeterminate: no label is written from it.
//
// Shell commands are split into simple commands and words by a small tokenizer (quotes, backslashes,
// here-document bodies removed). That is not a shell parser: variables, command substitution, aliases, functions
// and scripts are not followed. What this cannot see is listed in docs/KERNEL.ko.md.

const str = x => (typeof x === 'string' && x !== '' ? x : null);

const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'bat']);
// Commands that never print file content. `find` is added when it has no -exec and feeds no xargs.
const NO_READ_VERBS = new Set(['ls', 'test', '[', 'stat', 'echo', 'printf', 'cd', 'pwd', 'mkdir', 'true']);
const PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'sudo', 'command', 'exec', 'nohup', 'env']);
const GREP_VERBS = new Set(['grep', 'egrep', 'fgrep', 'zgrep']);
const GREP_LONG_VALUE = new Set(['--include', '--exclude', '--exclude-dir', '--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context',
  '--label', '--color', '--colour', '--binary-files', '--devices', '--directories', '--exclude-from']);
const RG_VALUE = new Set(['-e', '--regexp', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '-m', '--max-count', '-f', '--file',
  '--max-depth', '-d', '--sort', '--sortr', '-j', '--threads', '--context', '--after-context', '--before-context', '-r', '--replace', '--color', '--colors', '-E', '--encoding', '-M']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_PATTERN = new Set(['-path', '-ipath', '-wholename', '-iwholename', '-name', '-iname', '-regex', '-iregex']);

/** Shell text -> [{ words, piped }]: simple commands in order; `piped` says the command reads the previous one's output. */
export function shellCommands(text) {
  // A here-document body is data for the command, not commands.
  const src = String(text ?? '').replace(/<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?(?:\n[ \t]*\2(?=\n|$)|$)/g, ' $3\n');
  const commands = [];
  let words = [], word = null, quote = null, piped = false;
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endCommand = nextPiped => { endWord(); if (words.length) commands.push({ words, piped }); words = []; piped = nextPiped; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) word += src[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    if (c === '\\') {
      if (i + 1 < src.length) { if (src[i + 1] === '\n') i++; else word = (word ?? '') + src[++i]; }
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') { endCommand(false); continue; }
    if (c === '|') {
      if (src[i + 1] === '|') { i++; endCommand(false); } else { if (src[i + 1] === '&') i++; endCommand(true); }
      continue;
    }
    if (c === '&') { if (src[i + 1] === '&') i++; endCommand(false); continue; }
    if (c === '<' || c === '>') {
      endWord();
      if (src[i + 1] === '<' || src[i + 1] === '>') i++;
      if (src[i + 1] === '&') i++;
      continue;
    }
    word = (word ?? '') + c;
  }
  endCommand(false);
  return commands;
}

// Does a file-name glob match "SKILL.md"? Unknown glob syntax answers true (the cautious side).
function globMatchesSkillFile(glob) {
  let base = String(glob).split('/').pop();
  if (base === '' || base === '**') return true;
  if (/[[\]\\]/.test(base)) return true;
  const alternatives = [];
  const expand = text => {
    const m = /\{([^{}]*)\}/.exec(text);
    if (!m) { alternatives.push(text); return; }
    for (const part of m[1].split(',')) expand(text.slice(0, m.index) + part + text.slice(m.index + m[0].length));
  };
  expand(base);
  return alternatives.some(alt => new RegExp('^' + alt.replace(/[.+^$()|]/g, '\\$&').replace(/\*+/g, '.*').replace(/\?/g, '.') + '$', 'i').test('SKILL.md'));
}

// A pattern that removes the skills folder (or the whole .claude folder) as a whole: an exclusion glob, a find
// -path, or the pattern of an output filter (grep -v) right behind a search.
function excludesSkillsFolder(pattern) {
  const p = String(pattern).replace(/\\/g, '').replace(/^!/, '').replace(/^\^/, '')
    .replace(/(?:\/\*\*|\/\*|\*|\/)$/, '').replace(/^(?:\.\/|\*\*\/|\*\/|\/)/, '');
  return p === '.claude' || p === '.claude/skills';
}

const trimSlash = p => (p.length > 1 ? p.replace(/\/+$/, '') : p);

// Does searching this path recursively reach the project's skills folder? true / false; a path this code
// cannot resolve (a variable, an absolute path with no known project root) answers true.
function reachesSkillsFolder(raw, roots) {
  const p = trimSlash(raw);
  if (['.', './.', '..', '~', '/', '$PWD', '${PWD}', '$(pwd)', '$HOME'].includes(p)) return true;
  if (/[$`]/.test(p)) return true;
  if (/^(?:\.\/)?\.\*/.test(p)) return true;
  if (/^(?:\.\/)?\.claude(?:$|\/skills(?:$|\/))/.test(p)) return true;
  if (p.startsWith('../')) return true;
  if (p.startsWith('/')) {
    if (!roots.length) return true;
    return roots.some(root => p === root || root.startsWith(p + '/') || p === root + '/.claude' || p === root + '/.claude/skills' || p.startsWith(root + '/.claude/skills/'));
  }
  return false;
}

// "<prefix>.claude/skills/<folder>[/<rest>]" -> where the path points. `rest` is null for the folder itself.
function skillPath(raw, roots, elsewhere) {
  const m = /^(.*?)\.claude\/skills\/([^/]+)(?:\/(.*))?$/.exec(String(raw));
  if (!m || (m[1] !== '' && !m[1].endsWith('/'))) return null;
  const prefix = m[1];
  let where;
  if (prefix === '' || prefix === './') where = elsewhere ? 'unknown' : 'project';
  else if (prefix.startsWith('/')) where = !roots.length ? 'unknown' : roots.some(root => prefix === root + '/') ? 'project' : 'outside';
  else where = 'unknown';
  return { where, folder: m[2], rest: m[3] ?? null };
}

function grepArguments(args) {
  const out = { recursive: false, invert: false, includes: [], excludeDirs: [], positional: [], patternGiven: false, skip: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { for (let k = i + 1; k < args.length; k++) out.positional.push({ word: args[k], index: k }); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      let value = eq < 0 ? null : a.slice(eq + 1);
      out.skip.add(i);
      if (eq < 0 && GREP_LONG_VALUE.has(name)) { value = args[i + 1] ?? null; out.skip.add(i + 1); i++; }
      if (name === '--recursive' || name === '--dereference-recursive') out.recursive = true;
      else if (name === '--invert-match') out.invert = true;
      else if (name === '--include' && value !== null) out.includes.push(value);
      else if (name === '--exclude-dir' && value !== null) out.excludeDirs.push(value);
      else if (name === '--regexp' || name === '--file') out.patternGiven = true;
      continue;
    }
    if (/^-[A-Za-z0-9]+$/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const flag = a[k];
        if (flag === 'r' || flag === 'R') out.recursive = true;
        else if (flag === 'v') out.invert = true;
        else if ('efmABCdD'.includes(flag)) {
          if (flag === 'e' || flag === 'f') out.patternGiven = true;
          if (k === a.length - 1) { out.skip.add(i + 1); i++; }
          break;
        }
      }
      continue;
    }
    out.positional.push({ word: a, index: i });
  }
  if (!out.patternGiven && out.positional.length) { out.pattern = out.positional[0].word; out.skip.add(out.positional[0].index); out.positional.shift(); }
  else out.pattern = null;
  out.paths = out.positional.map(p => p.word);
  return out;
}

/**
 * What one shell command did with the project's skills.
 * Returns { loads: [folder], indeterminate: [reason] }. `known` is the Map(folder -> name) of project skills.
 */
export function shellSkillAccess(command, { known, roots }) {
  const loads = [], indeterminate = [];
  const commands = shellCommands(command);
  let elsewhere = false;
  commands.forEach((entry, position) => {
    let start = 0;
    while (start < entry.words.length && (PREFIX_WORDS.has(entry.words[start]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry.words[start]))) start++;
    if (start >= entry.words.length) return;
    const verb = entry.words[start].split('/').pop();
    const args = entry.words.slice(start + 1);
    const skip = new Set();
    let noRead = NO_READ_VERBS.has(verb);
    if (verb === 'cd') {
      const target = args[0] ? trimSlash(args[0]) : null;
      elsewhere = !(target !== null && roots.includes(target));
      return;
    }
    // An output filter right behind a search that drops every line of the skills folder.
    const filteredOut = () => {
      for (let k = position + 1; k < commands.length && commands[k].piped; k++) {
        const next = commands[k].words;
        if (!GREP_VERBS.has(String(next[0]).split('/').pop())) continue;
        const parsed = grepArguments(next.slice(1));
        if (parsed.invert && parsed.pattern !== null && !parsed.paths.length && excludesSkillsFolder(parsed.pattern)) return true;
      }
      return false;
    };
    const search = (paths, excluded, restricted) => {
      if ((paths.length ? paths : ['.']).some(p => reachesSkillsFolder(p, roots)) && !excluded && !restricted && !filteredOut()) indeterminate.push('recursive_search_reaches_skills_folder');
    };
    const isGitGrep = verb === 'git' && args.find(a => !a.startsWith('-')) === 'grep';
    if (GREP_VERBS.has(verb) || isGitGrep) {
      const offset = isGitGrep ? args.indexOf('grep') + 1 : 0;
      const parsed = grepArguments(args.slice(offset));
      for (const index of parsed.skip) skip.add(index + offset);
      if (parsed.recursive || isGitGrep) {
        search(parsed.paths, parsed.excludeDirs.some(d => excludesSkillsFolder(d) || ['skills', '.*'].includes(d)),
          parsed.includes.length > 0 && !parsed.includes.some(globMatchesSkillFile));
      }
    } else if (verb === 'rg' || verb === 'ag' || verb === 'ack') {
      let hidden = verb === 'ack', files = false, unrestricted = 0, patternGiven = false;
      const globs = [], types = [], positional = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const eq = a.startsWith('--') ? a.indexOf('=') : -1;
        const name = eq < 0 ? a : a.slice(0, eq);
        let value = eq < 0 ? null : a.slice(eq + 1);
        if (a.startsWith('-') && a !== '-') {
          skip.add(i);
          if (eq < 0 && RG_VALUE.has(name)) { value = args[i + 1] ?? null; skip.add(i + 1); i++; }
          if (name === '--hidden' || name === '-.' || name === '--unrestricted' && (unrestricted += 1) >= 2) hidden = true;
          if (/^-[A-Za-z.]+$/.test(name)) { unrestricted += (name.match(/u/g) ?? []).length; if (unrestricted >= 2 || name.includes('.')) hidden = true; }
          if (name === '--files' || name === '--type-list') files = true;
          if ((name === '-g' || name === '--glob' || name === '--iglob') && value !== null) globs.push(value);
          if ((name === '-t' || name === '--type') && value !== null) types.push(value);
          if (name === '-e' || name === '--regexp' || name === '-f' || name === '--file') patternGiven = true;
          continue;
        }
        positional.push({ word: a, index: i });
      }
      if (!patternGiven && !files && positional.length) { skip.add(positional[0].index); positional.shift(); }
      const paths = positional.map(p => p.word);
      const positive = globs.filter(g => !g.startsWith('!'));
      const named = paths.filter(p => /^(?:\.\/)?\.claude(?:$|\/)/.test(trimSlash(p)) || roots.some(root => trimSlash(p).startsWith(root + '/.claude')));
      // These tools skip hidden folders unless told otherwise or given the folder by name.
      if (!files) search(hidden ? paths : named.length ? named : ['./not-hidden'], globs.some(g => g.startsWith('!') && excludesSkillsFolder(g)),
        (positive.length > 0 && !positive.some(globMatchesSkillFile)) || (types.length > 0 && !types.some(t => ['md', 'markdown'].includes(t))));
    } else if (verb === 'find') {
      const first = args.findIndex(a => a.startsWith('-') || a === '(' || a === '!');
      const paths = first < 0 ? args : args.slice(0, first);
      let excluded = false;
      const positiveNames = [];
      let executes = false;
      args.forEach((a, i) => {
        if (FIND_PATTERN.has(a)) {
          skip.add(i + 1);
          const negated = args[i - 1] === '-not' || args[i - 1] === '!' || args[i + 2] === '-prune';
          const value = args[i + 1] ?? '';
          if (negated && (excludesSkillsFolder(value) || (a === '-name' && ['.claude', 'skills'].includes(value)))) excluded = true;
          if (!negated && (a === '-name' || a === '-iname')) positiveNames.push(value);
        }
        if (FIND_EXEC.has(a) && !NO_READ_VERBS.has(String(args[i + 1] ?? '').split('/').pop())) executes = true;
      });
      const next = commands[position + 1];
      if (next?.piped && String(next.words[0]).split('/').pop() === 'xargs') {
        const target = next.words.slice(1).find(w => !w.startsWith('-') && !/^\d+$/.test(w) && w !== '{}');
        if (!target || !NO_READ_VERBS.has(target.split('/').pop())) executes = true;
      }
      if (executes) search(paths, excluded, positiveNames.length > 0 && !positiveNames.some(globMatchesSkillFile));
      else noRead = true;
    }

    args.forEach((raw, index) => {
      if (skip.has(index) || raw.startsWith('^') || raw.startsWith('!')) return;
      if (!raw.includes('SKILL.md') && !raw.includes('.claude/skills')) return;
      if (noRead) return;
      const at = skillPath(raw, roots, elsewhere);
      if (at && at.where === 'outside' && !known.has(at.folder)) return;
      if (at && at.where === 'project' && at.rest === 'SKILL.md' && known.has(at.folder)) {
        if (READ_VERBS.has(verb)) loads.push(at.folder); else indeterminate.push('shell_names_skill_file_without_reading_verb');
        return;
      }
      indeterminate.push('shell_touches_skills_folder');
    });
  });
  return { loads, indeterminate };
}

/**
 * calls:   [{ id, name, input }] in transcript order
 * results: Map(tool_use id -> { isError })
 * known:   Map(folder -> skill name) of the session's project skills
 * roots:   project roots the host recorded for this transcript (row `cwd`); used locally, never returned
 * Returns { loaded: [{ name, via, index }], otherSkillCalls, indeterminate, reasons: { reason: count } }.
 */
export function classifySkillAccess(calls, results, { known = new Map(), roots = [] } = {}) {
  const names = new Set(known.values());
  const loaded = [], reasons = {};
  let otherSkillCalls = 0;
  const unsure = reason => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const outcomeOf = call => { const r = call.id === null ? null : results.get(call.id); return !r ? 'missing' : r.isError ? 'error' : 'ok'; };
  // A load counts only when the tool answered without an error: the call alone does not show the text arrived.
  const load = (name, via, index, call) => {
    const outcome = outcomeOf(call);
    if (outcome !== 'ok') { unsure(outcome === 'error' ? 'load_call_returned_an_error' : 'load_call_has_no_result'); return; }
    if (!loaded.some(l => l.name === name)) loaded.push({ name, via, index });
  };
  calls.forEach((call, index) => {
    if (call.name === 'Skill') {
      const raw = str(call.input.skill);
      const last = raw?.split(':').pop() ?? null;
      const name = raw !== null && names.has(raw) ? raw : last !== null && names.has(last) ? last : null;
      if (name !== null) load(name, 'Skill', index, call); else otherSkillCalls++;
    } else if (call.name === 'Read') {
      const at = skillPath(String(call.input.file_path ?? ''), roots, false);
      if (!at || at.rest === null) return;
      if (at.where === 'outside') { if (known.has(at.folder)) unsure('same_named_skill_file_outside_project'); return; }
      if (at.where === 'unknown') { unsure('skill_file_location_unknown'); return; }
      if (!known.has(at.folder)) unsure('skill_folder_not_known');
      else if (at.rest === 'SKILL.md') load(known.get(at.folder), 'Read', index, call);
      else unsure('read_inside_skill_folder');
    } else if (call.name === 'Bash') {
      const found = shellSkillAccess(String(call.input.command ?? ''), { known, roots });
      for (const reason of found.indeterminate) unsure(reason);
      for (const folder of found.loads) load(known.get(folder), 'Shell', index, call);
    } else if (call.name === 'Grep') {
      // A search that returned an error returned no text.
      if (outcomeOf(call) === 'error') return;
      const where = String(call.input.path ?? ''), glob = str(call.input.glob), type = str(call.input.type);
      if (where.includes('.claude/skills') || (glob ?? '').includes('.claude/skills')) { unsure('content_search_inside_skills_folder'); return; }
      const restricted = (glob !== null && !globMatchesSkillFile(glob)) || (type !== null && !['md', 'markdown'].includes(type));
      if (reachesSkillsFolder(where === '' ? '.' : where, roots) && !restricted) unsure('recursive_search_reaches_skills_folder');
    }
  });
  return { loaded, otherSkillCalls, indeterminate: Object.keys(reasons).length > 0, reasons };
}
