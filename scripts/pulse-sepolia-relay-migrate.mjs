import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

// Explicit operator step. The site never changes its own database schema.
const url = process.env.PULSE_RELAY_DATABASE_URL;
assert.ok(url, 'PULSE_RELAY_DATABASE_URL is required');
const pool = new Pool({ connectionString: url, max: 1 });
try {
  await pool.query(readFileSync(new URL('./pulse-sepolia-relay-schema.sql', import.meta.url), 'utf8'));
  console.log('Public Sepolia relay schema installed.');
} finally { await pool.end(); }
