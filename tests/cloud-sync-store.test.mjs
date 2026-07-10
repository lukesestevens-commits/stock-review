import assert from 'node:assert/strict';
import { createTzzbSyncStore } from '../cloud/tzzb-sync-store.mjs';

class FakeD1 {
  constructor() {
    this.row = null;
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
        if (!/SELECT payload_json/.test(sql)) throw new Error(`Unexpected first SQL: ${sql}`);
        return db.row;
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS tzzb_latest_sync/.test(sql)) {
          db.schemaReady = true;
          return { success: true };
        }
        if (/INSERT INTO tzzb_latest_sync/.test(sql)) {
          assert.equal(db.schemaReady, true, 'schema must exist before write');
          db.row = {
            target_date: values[0],
            received_at: values[1],
            payload_json: values[2]
          };
          return { success: true };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      }
    };
  }
}

const db = new FakeD1();
const store = createTzzbSyncStore(db);

assert.equal(await store.readLatest(), null);
assert.equal(db.schemaReady, true);

const first = {
  targetDate: '2026-07-10',
  receivedAt: '2026-07-10T10:00:00.000Z',
  records: [{ url: '/first' }]
};
await store.writeLatest(first);
assert.deepEqual(await store.readLatest(), first);

const replacement = {
  targetDate: '2026-07-11',
  receivedAt: '2026-07-11T09:30:00.000Z',
  records: [{ url: '/replacement' }]
};
await store.writeLatest(replacement);
assert.deepEqual(await store.readLatest(), replacement);

assert.throws(() => createTzzbSyncStore(null), /D1 binding DB is required/);

console.log('PASS cloud sync store');
