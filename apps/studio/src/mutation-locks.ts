export class MutationLocks {
  private entries = new Map<symbol, { keys: string[]; after?: number }>();
  blocked(keys: string[]) {
    return [...this.entries.values()].some(entry => keys.includes('work') || entry.keys.includes('work') || keys.some(key => entry.keys.includes(key)));
  }
  acquire(keys: string[]) {
    if (this.blocked(keys)) return;
    const token = Symbol('mutation');
    this.entries.set(token, { keys });
    return token;
  }
  awaiting(token: symbol, epoch: number) {
    const entry = this.entries.get(token);
    if (entry) entry.after = epoch + 1;
  }
  synchronized(epoch: number) {
    for (const [token, entry] of this.entries) if (entry.after !== undefined && epoch >= entry.after) this.entries.delete(token);
  }
}
