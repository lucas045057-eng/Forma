export class SceneDraftGuard {
  dirty = false;
  private revision = 0;
  edit() { this.dirty = true; this.invalidate(); }
  invalidate() { ++this.revision; }
  saved() { this.dirty = false; this.invalidate(); }
  beginLoad(explicit = false) {
    if (this.dirty && !explicit) return null;
    return ++this.revision;
  }
  canApply(revision: number) { return revision === this.revision; }
}
