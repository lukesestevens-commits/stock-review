import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createReviewDraftStore } from '../cloud/review-draft-store.mjs';

class MemoryD1 {
  constructor() {
    this.rows = new Map();
    this.schemaReady = false;
  }

  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...nextValues) {
        values = nextValues;
        return this;
      },
      async first() {
        if (/FROM review_drafts/.test(sql)) return structuredClone(db.rows.get(values[0]) || null);
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS review_drafts/.test(sql)) {
          db.schemaReady = true;
          return { success: true };
        }
        assert.equal(db.schemaReady, true, 'schema exists before draft writes');
        if (/INSERT INTO review_drafts/.test(sql)) {
          const [reviewDate, updatedAt, recordJson] = values;
          if (db.rows.has(reviewDate)) throw new Error('unique constraint');
          db.rows.set(reviewDate, {
            review_date: reviewDate,
            version: 1,
            updated_at: updatedAt,
            record_json: recordJson
          });
          return { meta: { changes: 1 } };
        }
        if (/UPDATE review_drafts/.test(sql)) {
          const [updatedAt, recordJson, reviewDate, expectedVersion] = values;
          const current = db.rows.get(reviewDate);
          if (!current || current.version !== expectedVersion) return { meta: { changes: 0 } };
          db.rows.set(reviewDate, {
            ...current,
            version: current.version + 1,
            updated_at: updatedAt,
            record_json: recordJson
          });
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      }
    };
  }
}

const db = new MemoryD1();
const store = createReviewDraftStore(db);
assert.equal(await store.read('2026-07-15'), null);

const first = await store.save({
  reviewDate: '2026-07-15',
  expectedVersion: 0,
  updatedAt: '2026-07-15T08:00:00.000Z',
  record: { date: '2026-07-15', plan: { banRule: '不做计划外交易' } }
});
assert.equal(first.version, 1);
assert.equal((await store.read('2026-07-15')).record.plan.banRule, '不做计划外交易');

const second = await store.save({
  reviewDate: '2026-07-15',
  expectedVersion: 1,
  updatedAt: '2026-07-15T08:01:00.000Z',
  record: { date: '2026-07-15', plan: { banRule: '开盘不冲动' } }
});
assert.equal(second.version, 2);

await assert.rejects(
  store.save({
    reviewDate: '2026-07-15',
    expectedVersion: 1,
    updatedAt: '2026-07-15T08:02:00.000Z',
    record: { date: '2026-07-15' }
  }),
  (error) => error.code === 'DRAFT_VERSION_CONFLICT' && error.current.version === 2
);

await assert.rejects(
  store.save({
    reviewDate: '2026-07-16',
    expectedVersion: 0,
    updatedAt: '2026-07-16T08:00:00.000Z',
    record: { note: 'x'.repeat(513 * 1024) }
  }),
  /too large/
);

const migration = fs.readFileSync(new URL('../drizzle/0003_review_drafts.sql', import.meta.url), 'utf8');
assert.match(migration, /CREATE TABLE IF NOT EXISTS review_drafts/);
assert.match(migration, /review_date TEXT PRIMARY KEY/);
assert.match(migration, /version INTEGER NOT NULL/);

console.log('PASS review draft store');
