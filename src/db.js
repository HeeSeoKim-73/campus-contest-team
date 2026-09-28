import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, department TEXT NOT NULL,
      password TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
      verification_hash TEXT, verification_expires INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL, contest TEXT NOT NULL, description TEXT NOT NULL,
      deadline TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS quotas (
      post_id INTEGER NOT NULL REFERENCES posts(id), department TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 20),
      PRIMARY KEY(post_id, department)
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id),
      user_id INTEGER NOT NULL REFERENCES users(id), department TEXT NOT NULL,
      motivation TEXT NOT NULL, skills TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id,user_id),
      FOREIGN KEY(post_id,department) REFERENCES quotas(post_id,department)
    );
    CREATE INDEX IF NOT EXISTS applications_status ON applications(post_id,department,status);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
  `);
  return db;
}

export function quotasFor(db, postId) {
  return db.prepare(`SELECT q.department,q.capacity,
    (SELECT COUNT(*) FROM applications a WHERE a.post_id=q.post_id
     AND a.department=q.department AND a.status='approved') AS filled
    FROM quotas q WHERE q.post_id=? ORDER BY q.department`).all(postId);
}

export function decideApplication(db, applicationId, ownerId, status) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const a = db.prepare(`SELECT a.*,p.owner_id FROM applications a JOIN posts p ON p.id=a.post_id WHERE a.id=?`).get(applicationId);
    if (!a || a.owner_id !== ownerId) throw Object.assign(new Error('이 지원서를 관리할 권한이 없습니다.'), { status: 403 });
    if (!['approved','rejected'].includes(status)) throw Object.assign(new Error('올바르지 않은 처리입니다.'), { status: 400 });
    if (a.status !== 'pending') throw Object.assign(new Error('이미 처리된 지원서입니다.'), { status: 409 });
    if (status === 'approved') {
      const q = quotasFor(db, a.post_id).find(q => q.department === a.department);
      if (!q || q.filled >= q.capacity) throw Object.assign(new Error('해당 학과의 모집 정원이 이미 찼습니다.'), { status: 409 });
    }
    db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, applicationId);
    db.exec('COMMIT');
    return a.post_id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
