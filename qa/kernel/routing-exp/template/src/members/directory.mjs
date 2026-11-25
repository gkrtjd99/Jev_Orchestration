// The member directory. Display names are unique within a studio.
import { ConflictError, NotFoundError, ValidationError } from '../util/errors.mjs';
import { validateDisplayName, nameKey } from './names.mjs';

const TIERS = ['vip', 'regular', 'trial'];

export class MemberDirectory {
  constructor({ store, ids }) {
    this.store = store;
    this.ids = ids;
  }

  async register({ displayName, email = null, tier = 'regular' }) {
    const name = validateDisplayName(displayName);
    if (!TIERS.includes(tier)) throw new ValidationError('UNKNOWN_TIER', `Unknown tier: ${tier}`);
    const key = `member-name:${nameKey(name)}`;
    if (await this.store.get(key)) throw new ConflictError('NAME_TAKEN', `The name ${name} is already in use`);
    const member = { id: this.ids.next(), displayName: name, email, tier };
    await this.store.set(`member:${member.id}`, member);
    await this.store.set(key, member.id);
    return member;
  }

  async get(id) {
    const member = await this.store.get(`member:${id}`);
    if (!member) throw new NotFoundError('MEMBER_NOT_FOUND', `No member ${id}`);
    return member;
  }

  async rename(id, displayName) {
    const member = await this.get(id);
    const name = validateDisplayName(displayName);
    const key = `member-name:${nameKey(name)}`;
    const holder = await this.store.get(key);
    if (holder && holder !== id) throw new ConflictError('NAME_TAKEN', `The name ${name} is already in use`);
    await this.store.delete(`member-name:${nameKey(member.displayName)}`);
    const renamed = { ...member, displayName: name };
    await this.store.set(`member:${id}`, renamed);
    await this.store.set(key, id);
    return renamed;
  }

  async list() {
    const rows = await this.store.list('member:');
    return rows.map((row) => row.value).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
