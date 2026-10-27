require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1);
const SQLiteStore = SQLiteStoreFactory(session);
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const uploadDirectory = path.join(__dirname, 'public', 'uploads');
const maxCandidateImageBytes = 1.5 * 1024 * 1024;
fs.mkdirSync(uploadDirectory, { recursive: true });
const secret = process.env.SESSION_SECRET || '';
if (secret.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters. Copy .env.example to .env and set a strong secret.');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'election.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS election_terms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    party TEXT NOT NULL,
    slogan TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#2563eb',
    image_url TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY,
    voter_id TEXT NOT NULL,
    election_term_id INTEGER NOT NULL REFERENCES election_terms(id),
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(voter_id, election_term_id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(provider, provider_user_id)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    event TEXT NOT NULL,
    actor_id TEXT,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS election_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'scheduled')),
    manual_open INTEGER NOT NULL DEFAULT 0 CHECK (manual_open IN (0, 1)),
    starts_at TEXT,
    ends_at TEXT,
    current_term_id INTEGER REFERENCES election_terms(id),
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS site_content (
    content_key TEXT PRIMARY KEY,
    content_value TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);
const candidateColumns = db.prepare('PRAGMA table_info(candidates)').all();
if (!candidateColumns.some(column => column.name === 'image_url')) {
  db.exec('ALTER TABLE candidates ADD COLUMN image_url TEXT');
}
db.prepare('INSERT OR IGNORE INTO election_settings (id, manual_open) VALUES (1, ?)')
  .run(process.env.ELECTION_OPEN === 'true' ? 1 : 0);
const voteColumns = db.prepare('PRAGMA table_info(votes)').all();
if (voteColumns.some(column => column.name === 'roblox_user_id') && !voteColumns.some(column => column.name === 'voter_id')) {
  db.exec('ALTER TABLE votes RENAME COLUMN roblox_user_id TO voter_id');
}
const settingColumns = db.prepare('PRAGMA table_info(election_settings)').all();
if (!settingColumns.some(column => column.name === 'current_term_id')) {
  db.exec('ALTER TABLE election_settings ADD COLUMN current_term_id INTEGER REFERENCES election_terms(id)');
}
let currentTermId = db.prepare('SELECT current_term_id FROM election_settings WHERE id = 1').get().current_term_id;
if (!currentTermId || !db.prepare('SELECT 1 FROM election_terms WHERE id = ?').get(currentTermId)) {
  const createInitialTerm = db.transaction(() => {
    const result = db.prepare("INSERT INTO election_terms (name) VALUES ('สมัยที่ 1')").run();
    db.prepare('UPDATE election_settings SET current_term_id = ? WHERE id = 1').run(result.lastInsertRowid);
    return Number(result.lastInsertRowid);
  });
  currentTermId = createInitialTerm();
}
if (!voteColumns.some(column => column.name === 'election_term_id')) {
  const migrateVotes = db.transaction(() => {
    db.exec(`
      ALTER TABLE votes RENAME TO votes_legacy;
      CREATE TABLE votes (
        id INTEGER PRIMARY KEY,
        voter_id TEXT NOT NULL,
        election_term_id INTEGER NOT NULL REFERENCES election_terms(id),
        candidate_id INTEGER NOT NULL REFERENCES candidates(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(voter_id, election_term_id)
      );
    `);
    db.prepare(`INSERT INTO votes (id, voter_id, election_term_id, candidate_id, created_at)
      SELECT id, voter_id, ?, candidate_id, created_at FROM votes_legacy`).run(currentTermId);
    db.exec('DROP TABLE votes_legacy');
  });
  migrateVotes();
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS votes_voter_term_unique ON votes(voter_id, election_term_id)');
const removeUnusedSampleCandidates = db.transaction(() => {
  const samples = [
    [1, 'นายธนภัทร วัฒนากุล', 'กลุ่มพิทักษ์ชายแดน', 'ดูแลแนวชายแดน ร่วมพัฒนาชุมชน'],
    [2, 'นายศรัณย์ เรืองวิทย์', 'กลุ่มพัฒนาฐานที่มั่น', 'สร้างพื้นที่ให้มั่นคงและน่าอยู่'],
    [3, 'นายกิตติพงศ์ สุขสวัสดิ์', 'กลุ่มสวัสดิการทหาร', 'ใส่ใจทหารและชุมชน'],
    [4, 'นายอัครินทร์ ชัยวัฒน์', 'กลุ่มรวมพลังอาสา', 'ร่วมมือกันสร้างกิจกรรมที่สนุก']
  ];
  const existingCandidates = db.prepare('SELECT id, number, name, party, slogan FROM candidates').all();
  const hasVotes = db.prepare('SELECT 1 FROM votes WHERE candidate_id = ? LIMIT 1');
  const deactivate = db.prepare('UPDATE candidates SET active = 0 WHERE id = ?');
  const remove = db.prepare('DELETE FROM candidates WHERE id = ?');
  const normalize = value => String(value).normalize('NFC');
  let removed = 0;
  let deactivated = 0;
  for (const sample of samples) {
    const candidate = existingCandidates.find(row => row.number === sample[0]
      && row.name && normalize(row.name) === normalize(sample[1])
      && normalize(row.party) === normalize(sample[2])
      && normalize(row.slogan) === normalize(sample[3]));
    if (!candidate) continue;
    if (hasVotes.get(candidate.id)) deactivated += deactivate.run(candidate.id).changes;
    else removed += remove.run(candidate.id).changes;
  }
  if (removed || deactivated) {
    db.prepare(`UPDATE election_settings SET mode = 'manual', manual_open = 0, starts_at = NULL,
      ends_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run();
    db.prepare('INSERT INTO audit_log(event, actor_id, detail) VALUES (?, NULL, ?)')
      .run('sample_candidates_removed', `removed=${removed}; deactivated=${deactivated}; election closed`);
  }
  return removed;
});
removeUnusedSampleCandidates();
const candidateTableSql = db.prepare(`SELECT sql FROM sqlite_master
  WHERE type = 'table' AND name = 'candidates'`).get()?.sql || '';
if (/number\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i.test(candidateTableSql)) {
  db.pragma('foreign_keys = OFF');
  try {
    const migrateCandidateNumbers = db.transaction(() => {
      db.exec(`
        CREATE TABLE candidates_new (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL,
          name TEXT NOT NULL,
          party TEXT NOT NULL,
          slogan TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#2563eb',
          image_url TEXT,
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO candidates_new (id, number, name, party, slogan, color, image_url, active)
          SELECT id, number, name, party, slogan, color, image_url, active FROM candidates;
        DROP TABLE candidates;
        ALTER TABLE candidates_new RENAME TO candidates;
        CREATE UNIQUE INDEX candidates_active_number_unique ON candidates(number) WHERE active = 1;
      `);
      const violations = db.pragma('foreign_key_check');
      if (violations.length) throw new Error('Candidate migration produced foreign-key violations');
    });
    migrateCandidateNumbers();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS candidates_active_number_unique ON candidates(number) WHERE active = 1');
const defaultSiteContent = {
  heroTitle: 'เลือกนายกรัฐมนตรี',
  heroSubtitle: 'ร่วมกำหนดทิศทางประเทศ',
  heroDescription: 'ตรวจสอบผู้สมัครและหมายเลขก่อนลงคะแนนในกิจกรรม Roleplay',
  eventName: 'The lives of Thai soldiers on the border',
  notice: 'กิจกรรมจำลองภายใน Roblox เท่านั้น ไม่ใช่การเลือกตั้งหรือหน่วยงานของรัฐในชีวิตจริง',
  footerSlogan: '“เสียงของคุณ ร่วมสร้างอนาคตของเรา”'
};

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false })); // Add a strict CSP before production deployment.
app.use(express.json({ limit: '2.2mb' }));
app.use(session({
  name: 'rp-election.sid',
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: __dirname }),
  secret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 1000 * 60 * 60 * 4 }
}));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use('/auth/', rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const audit = db.prepare('INSERT INTO audit_log(event,actor_id,detail) VALUES (?,?,?)');
const adminIds = {
  roblox: new Set((process.env.ADMIN_ROBLOX_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
  discord: new Set((process.env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean))
};
const discordConfigured = Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI);
const discordCallbackMatchesRequest = req => {
  try {
    const callback = new URL(process.env.DISCORD_REDIRECT_URI);
    return callback.origin === `${req.protocol}://${req.get('host')}`
      && callback.pathname === '/auth/discord/callback'
      && !callback.search && !callback.hash;
  } catch {
    return false;
  }
};
const validDiscordId = value => /^\d{17,20}$/.test(String(value || ''));
const discordAvatarUrl = (userId, avatarHash) => {
  if (typeof avatarHash === 'string' && /^(a_)?[a-f0-9]{32}$/i.test(avatarHash)) {
    const extension = avatarHash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=128`;
  }
  const defaultAvatar = Number((BigInt(userId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatar}.png`;
};
const oauthValueMatches = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const saveSession = req => new Promise((resolve, reject) => {
  req.session.save(error => error ? reject(error) : resolve());
});
const requireLogin = (req, res, next) => {
  if (!req.session.user || req.session.user.provider !== 'discord' || !validDiscordId(req.session.user.providerUserId)) {
    return res.status(401).json({ error: 'กรุณาลงทะเบียนหรือเข้าสู่ระบบ Discord ก่อน' });
  }
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session.user || !adminIds[req.session.user.provider]?.has(String(req.session.user.providerUserId))) return res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบที่ได้รับอนุญาต' });
  next();
};
const getElectionSettings = () => db.prepare(`SELECT mode, manual_open AS manualOpen, starts_at AS startsAt,
  ends_at AS endsAt, current_term_id AS currentTermId, updated_at AS updatedAt FROM election_settings WHERE id = 1`).get();
const getCurrentElectionTerm = () => db.prepare('SELECT id, name, created_at AS createdAt FROM election_terms WHERE id = ?').get(currentTermId);
const hasActiveCandidates = () => db.prepare('SELECT 1 FROM candidates WHERE active = 1 LIMIT 1').get() !== undefined;
const isElectionOpen = (settings = getElectionSettings(), now = Date.now()) => {
  if (!hasActiveCandidates()) return false;
  if (settings.mode === 'manual') return settings.manualOpen === 1;
  const startsAt = Date.parse(settings.startsAt);
  const endsAt = Date.parse(settings.endsAt);
  return Number.isFinite(startsAt) && Number.isFinite(endsAt) && now >= startsAt && now < endsAt;
};
const isAdminUser = user => Boolean(user && adminIds[user.provider]?.has(String(user.providerUserId)));
const validISODate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
const getSiteContent = () => {
  const content = { ...defaultSiteContent };
  for (const row of db.prepare('SELECT content_key, content_value FROM site_content').all()) {
    if (Object.hasOwn(defaultSiteContent, row.content_key)) content[row.content_key] = row.content_value;
  }
  return content;
};
const normalizeCandidate = body => {
  body = body && typeof body === 'object' ? body : {};
  const number = Number(body.number);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const party = typeof body.party === 'string' ? body.party.trim() : '';
  const slogan = typeof body.slogan === 'string' ? body.slogan.trim() : '';
  const color = typeof body.color === 'string' ? body.color.trim() : '';
  if (!Number.isSafeInteger(number) || number < 1 || number > 9999
    || !name || name.length > 80 || !party || party.length > 80
    || slogan.length > 220 || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  return { number, name, party, slogan, color };
};
const parseCandidateImage = imageData => {
  if (typeof imageData !== 'string') return null;
  const match = imageData.match(/^data:image\/(jpeg|png|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match) throw new Error('เลือกรูป JPG, PNG หรือ WebP ที่ถูกต้อง');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxCandidateImageBytes) {
    throw new Error('รูปภาพต้องมีขนาดไม่เกิน 1.5 MB');
  }
  const signatures = {
    jpeg: buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    png: buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    webp: buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  };
  if (!signatures[match[1].toLowerCase()]) throw new Error('ชนิดข้อมูลไม่ตรงกับไฟล์รูปภาพ');
  const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  return { buffer, extension };
};
const saveCandidateImage = image => {
  if (!image) return null;
  const filename = `${crypto.randomUUID()}.${image.extension}`;
  fs.writeFileSync(path.join(uploadDirectory, filename), image.buffer, { flag: 'wx' });
  return `/uploads/${filename}`;
};
const removeCandidateImage = imageUrl => {
  if (typeof imageUrl !== 'string') return;
  const match = imageUrl.match(/^\/uploads\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/i);
  if (!match) return;
  try {
    fs.unlinkSync(path.join(uploadDirectory, match[1]));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

app.get('/api/status', (req, res) => {
  const settings = getElectionSettings();
  const authenticated = Boolean(req.session.user);
  const voterId = authenticated ? `discord:${req.session.user.providerUserId}` : null;
  const term = getCurrentElectionTerm();
  res.json({
    electionOpen: isElectionOpen(settings),
    votingMode: settings.mode,
    votingStartsAt: settings.startsAt,
    votingEndsAt: settings.endsAt,
    electionTerm: term,
    authenticated,
    isAdmin: isAdminUser(req.session.user),
    hasVoted: voterId ? Boolean(db.prepare('SELECT 1 FROM votes WHERE voter_id = ? AND election_term_id = ?').get(voterId, currentTermId)) : false,
    user: req.session.user ? {
      displayName: req.session.user.displayName || 'ผู้เล่น',
      provider: req.session.user.provider,
      avatarUrl: req.session.user.avatarUrl
    } : null,
    authReady: discordConfigured,
    message: discordConfigured ? '' : 'กรุณาตั้งค่า Discord OAuth ในไฟล์ .env ก่อนลงทะเบียนหรือเข้าสู่ระบบ'
  });
});

app.post('/api/admin/election', requireLogin, requireAdmin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const actorId = `discord:${req.session.user.providerUserId}`;
  if (body.mode === 'manual' && typeof body.open === 'boolean') {
    const open = body.open;
    if (open && !hasActiveCandidates()) return res.status(409).json({ error: 'เพิ่มผู้สมัครที่ใช้งานก่อนเปิดรับคะแนน' });
    db.prepare(`UPDATE election_settings SET mode = 'manual', manual_open = ?, starts_at = NULL,
      ends_at = NULL, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`)
      .run(open ? 1 : 0, actorId);
    audit.run(open ? 'election_opened' : 'election_closed', actorId, 'manual');
    const settings = getElectionSettings();
    return res.json({ electionOpen: isElectionOpen(settings), settings });
  }

  if (body.mode === 'scheduled' && validISODate(body.startsAt) && validISODate(body.endsAt)) {
    const startsAt = Date.parse(body.startsAt);
    const endsAt = Date.parse(body.endsAt);
    if (!hasActiveCandidates()) return res.status(409).json({ error: 'เพิ่มผู้สมัครที่ใช้งานก่อนกำหนดเวลาเปิดรับคะแนน' });
    if (startsAt <= Date.now()) return res.status(400).json({ error: 'เวลาเริ่มต้องอยู่ในอนาคต' });
    if (endsAt <= startsAt) return res.status(400).json({ error: 'เวลาปิดต้องอยู่หลังเวลาเริ่ม' });
    db.prepare(`UPDATE election_settings SET mode = 'scheduled', manual_open = 0, starts_at = ?,
      ends_at = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`)
      .run(body.startsAt, body.endsAt, actorId);
    audit.run('election_schedule_updated', actorId, `${body.startsAt} to ${body.endsAt}`);
    const settings = getElectionSettings();
    return res.json({ electionOpen: isElectionOpen(settings), settings });
  }

  res.status(400).json({ error: 'ข้อมูลการเปิด ปิด หรือตั้งเวลาไม่ถูกต้อง' });
});

app.post('/api/admin/terms', requireLogin, requireAdmin, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'กรุณาระบุชื่อสมัยการเลือกตั้งไม่เกิน 80 ตัวอักษร' });
  if (isElectionOpen()) return res.status(409).json({ error: 'ปิดรับคะแนนก่อนเริ่มสมัยการเลือกตั้งใหม่' });
  const actorId = `discord:${req.session.user.providerUserId}`;
  try {
    const createTerm = db.transaction(() => {
      const result = db.prepare('INSERT INTO election_terms (name, created_by) VALUES (?, ?)').run(name, actorId);
      db.prepare(`UPDATE election_settings SET current_term_id = ?, mode = 'manual', manual_open = 0,
        starts_at = NULL, ends_at = NULL, updated_by = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`)
        .run(result.lastInsertRowid, actorId);
      audit.run('election_term_created', actorId, `term_id=${result.lastInsertRowid}; name=${name}`);
      return Number(result.lastInsertRowid);
    });
    currentTermId = createTerm();
    res.status(201).json({ ok: true, term: getCurrentElectionTerm() });
  } catch (error) {
    console.error('Election term creation failed:', error);
    res.status(500).json({ error: 'ไม่สามารถเริ่มสมัยการเลือกตั้งใหม่ได้' });
  }
});

app.get('/api/candidates', (req, res) => {
  const rows = db.prepare('SELECT id, number, name, party, slogan, color, image_url AS imageUrl FROM candidates WHERE active = 1 ORDER BY number').all();
  res.json(rows);
});

app.get('/api/results', (req, res) => {
  const rows = db.prepare(`SELECT c.id, c.number, c.name, c.party, COUNT(v.id) AS votes
    FROM candidates c LEFT JOIN votes v ON v.candidate_id = c.id AND v.election_term_id = ?
    WHERE c.active = 1 OR EXISTS (
      SELECT 1 FROM votes historical
      WHERE historical.candidate_id = c.id AND historical.election_term_id = ?
    )
    GROUP BY c.id ORDER BY c.number`).all(currentTermId, currentTermId);
  res.json({
    electionTerm: getCurrentElectionTerm(),
    results: rows,
    totalVotes: rows.reduce((sum, row) => sum + row.votes, 0)
  });
});

app.get('/api/site-content', (_req, res) => res.json(getSiteContent()));

app.get('/api/admin/overview', requireLogin, requireAdmin, (_req, res) => {
  res.json({
    electionTerm: getCurrentElectionTerm(),
    totalVotes: db.prepare('SELECT COUNT(*) AS count FROM votes WHERE election_term_id = ?').get(currentTermId).count,
    activeCandidates: db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE active = 1').get().count,
    registeredVoters: db.prepare('SELECT COUNT(*) AS count FROM users WHERE provider = ?').get('discord').count,
    recentEvents: db.prepare('SELECT event, actor_id, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 20').all()
  });
});

app.get('/api/admin/candidates', requireLogin, requireAdmin, (_req, res) => {
  const rows = db.prepare(`SELECT c.id, c.number, c.name, c.party, c.slogan, c.color, c.image_url AS imageUrl, c.active,
      (SELECT COUNT(*) FROM votes v WHERE v.candidate_id = c.id AND v.election_term_id = ?) AS votes,
      EXISTS (SELECT 1 FROM votes historical WHERE historical.candidate_id = c.id) AS hasVotes
    FROM candidates c ORDER BY c.number`).all(currentTermId);
  res.json(rows);
});

app.post('/api/admin/candidates', requireLogin, requireAdmin, (req, res) => {
  if (isElectionOpen()) return res.status(409).json({ error: 'ปิดรับคะแนนก่อนจัดการผู้สมัคร' });
  const candidate = normalizeCandidate(req.body);
  if (!candidate) return res.status(400).json({ error: 'กรุณากรอกหมายเลข ชื่อ กลุ่ม คำขวัญ และสีให้ถูกต้อง' });
  if (db.prepare('SELECT 1 FROM candidates WHERE number = ? AND active = 1').get(candidate.number)) {
    return res.status(409).json({ error: `หมายเลข ${candidate.number} มีผู้สมัครที่ใช้งานอยู่แล้ว` });
  }
  let image;
  try {
    image = parseCandidateImage(req.body.imageData);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  let imageUrl;
  try {
    imageUrl = saveCandidateImage(image);
  } catch (error) {
    console.error('Candidate image upload failed:', error);
    return res.status(500).json({ error: 'บันทึกรูปผู้สมัครไม่สำเร็จ กรุณาลองใหม่' });
  }
  const actorId = `discord:${req.session.user.providerUserId}`;
  try {
    const createCandidate = db.transaction(() => {
      const result = db.prepare(`INSERT INTO candidates (number, name, party, slogan, color, image_url, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)`).run(candidate.number, candidate.name, candidate.party, candidate.slogan, candidate.color, imageUrl);
      audit.run('candidate_created', actorId, `candidate_id=${result.lastInsertRowid}`);
      return result.lastInsertRowid;
    });
    res.status(201).json({ ok: true, id: createCandidate() });
  } catch (error) {
    if (imageUrl) {
      try {
        removeCandidateImage(imageUrl);
      } catch (cleanupError) {
        console.error('Candidate image rollback cleanup failed:', cleanupError);
      }
    }
    if (String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) {
      return res.status(409).json({ error: `หมายเลข ${candidate.number} มีผู้สมัครที่ใช้งานอยู่แล้ว` });
    }
    console.error('Candidate creation failed:', error);
    res.status(500).json({ error: 'ไม่สามารถเพิ่มผู้สมัครได้' });
  }
});

app.put('/api/admin/candidates/:id', requireLogin, requireAdmin, (req, res) => {
  if (isElectionOpen()) return res.status(409).json({ error: 'ปิดรับคะแนนก่อนจัดการผู้สมัคร' });
  const id = Number(req.params.id);
  const candidate = normalizeCandidate(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !candidate || typeof req.body.active !== 'boolean') {
    return res.status(400).json({ error: 'ข้อมูลผู้สมัครไม่ถูกต้อง' });
  }
  const existing = db.prepare('SELECT number, name, party, slogan, color, image_url AS imageUrl, active FROM candidates WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'ไม่พบผู้สมัคร' });
  const settings = getElectionSettings();
  const activeCandidateCount = db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE active = 1').get().count;
  if (settings.mode === 'scheduled' && Date.parse(settings.startsAt) > Date.now()
    && existing.active === 1 && req.body.active === false && activeCandidateCount <= 1) {
    return res.status(409).json({ error: 'ไม่สามารถปิดใช้งานผู้สมัครทั้งหมดได้ขณะมีการเลือกตั้งตามกำหนดเวลา' });
  }
  const voteCount = db.prepare('SELECT COUNT(*) AS count FROM votes WHERE candidate_id = ?').get(id).count;
  let image;
  try {
    if (req.body.imageData !== undefined) image = parseCandidateImage(req.body.imageData);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const imageChanged = Boolean(image) || req.body.removeImage === true;
  if (voteCount && (imageChanged || Object.keys(candidate).some(key => candidate[key] !== existing[key]))) {
    return res.status(409).json({ error: 'ผู้สมัครที่มีคะแนนแล้วแก้ไขข้อมูลไม่ได้ เพื่อรักษาความถูกต้องของผลคะแนน' });
  }
  let imageUrl = existing.imageUrl;
  try {
    if (image) imageUrl = saveCandidateImage(image);
    else if (req.body.removeImage === true) imageUrl = null;
  } catch (error) {
    console.error('Candidate image update failed:', error);
    return res.status(500).json({ error: 'บันทึกรูปผู้สมัครไม่สำเร็จ กรุณาลองใหม่' });
  }
  const actorId = `discord:${req.session.user.providerUserId}`;
  try {
    const updateCandidate = db.transaction(() => {
      db.prepare(`UPDATE candidates SET number = ?, name = ?, party = ?, slogan = ?, color = ?, image_url = ?, active = ?
        WHERE id = ?`).run(candidate.number, candidate.name, candidate.party, candidate.slogan, candidate.color, imageUrl, req.body.active ? 1 : 0, id);
      audit.run('candidate_updated', actorId, `candidate_id=${id}; active=${req.body.active}`);
    });
    updateCandidate();
    if (imageChanged && existing.imageUrl && existing.imageUrl !== imageUrl) {
      try {
        removeCandidateImage(existing.imageUrl);
      } catch (error) {
        console.error('Old candidate image cleanup failed:', error);
      }
    }
    res.json({ ok: true });
  } catch (error) {
    if (imageUrl && imageUrl !== existing.imageUrl) {
      try {
        removeCandidateImage(imageUrl);
      } catch (cleanupError) {
        console.error('Candidate image rollback cleanup failed:', cleanupError);
      }
    }
    if (String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) {
      return res.status(409).json({ error: 'หมายเลขผู้สมัครนี้ถูกใช้แล้ว' });
    }
    console.error('Candidate update failed:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกข้อมูลผู้สมัครได้' });
  }
});

app.delete('/api/admin/candidates/:id', requireLogin, requireAdmin, (req, res) => {
  if (isElectionOpen()) return res.status(409).json({ error: 'ปิดรับคะแนนก่อนลบผู้สมัคร' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'รหัสผู้สมัครไม่ถูกต้อง' });
  const candidate = db.prepare('SELECT id, name, image_url AS imageUrl FROM candidates WHERE id = ?').get(id);
  if (!candidate) return res.status(404).json({ error: 'ไม่พบผู้สมัคร' });
  const hasVotes = Boolean(db.prepare('SELECT 1 FROM votes WHERE candidate_id = ? LIMIT 1').get(id));
  const actorId = `discord:${req.session.user.providerUserId}`;
  try {
    const removeCandidate = db.transaction(() => {
      if (hasVotes) {
        db.prepare('UPDATE candidates SET active = 0 WHERE id = ?').run(id);
        audit.run('candidate_archived', actorId, `candidate_id=${id}; has historical votes`);
      } else {
        db.prepare('DELETE FROM candidates WHERE id = ?').run(id);
        audit.run('candidate_deleted', actorId, `candidate_id=${id}`);
      }
    });
    removeCandidate();
    if (!hasVotes && candidate.imageUrl) {
      try {
        removeCandidateImage(candidate.imageUrl);
      } catch (error) {
        console.error('Deleted candidate image cleanup failed:', error);
      }
    }
    res.json({
      ok: true,
      archived: hasVotes,
      message: hasVotes
        ? 'ผู้สมัครมีคะแนนแล้ว จึงปิดใช้งานแทนการลบเพื่อเก็บประวัติคะแนน'
        : 'ลบผู้สมัครเรียบร้อยแล้ว'
    });
  } catch (error) {
    console.error('Candidate deletion failed:', error);
    res.status(500).json({ error: 'ลบผู้สมัครไม่สำเร็จ กรุณาลองใหม่' });
  }
});

app.get('/api/admin/site-content', requireLogin, requireAdmin, (_req, res) => res.json(getSiteContent()));

app.put('/api/admin/site-content', requireLogin, requireAdmin, (req, res) => {
  const keys = Object.keys(defaultSiteContent);
  if (!req.body || keys.some(key => typeof req.body[key] !== 'string' || !req.body[key].trim())
    || Object.keys(req.body).some(key => !keys.includes(key))) {
    return res.status(400).json({ error: 'กรุณากรอกเนื้อหาให้ครบถ้วน' });
  }
  const limits = { heroTitle: 100, heroSubtitle: 160, heroDescription: 400, eventName: 120, notice: 300, footerSlogan: 120 };
  if (keys.some(key => req.body[key].trim().length > limits[key])) {
    return res.status(400).json({ error: 'เนื้อหาบางรายการยาวเกินกำหนด' });
  }
  const actorId = `discord:${req.session.user.providerUserId}`;
  const updateContent = db.transaction(() => {
    const update = db.prepare(`INSERT INTO site_content (content_key, content_value, updated_by, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(content_key) DO UPDATE SET content_value = excluded.content_value,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    for (const key of keys) update.run(key, req.body[key].trim(), actorId);
    audit.run('site_content_updated', actorId, 'public website content');
  });
  try {
    updateContent();
    res.json({ ok: true, content: getSiteContent() });
  } catch (error) {
    console.error('Site content update failed:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกเนื้อหาหน้าเว็บได้' });
  }
});

app.get('/auth/discord', (req, res, next) => {
  if (!discordConfigured) return res.status(503).send('ยังไม่ได้ตั้งค่า Discord OAuth กรุณาตั้งค่า DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET และ DISCORD_REDIRECT_URI');
  if (!discordCallbackMatchesRequest(req)) {
    return res.status(503).send('ที่อยู่ Discord Redirect URI ไม่ตรงกับเว็บไซต์นี้ กรุณาตั้ง DISCORD_REDIRECT_URI เป็น URL HTTPS ของเว็บไซต์ตามด้วย /auth/discord/callback และตั้ง URL เดียวกันใน Discord Developer Portal');
  }
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  req.session.oauthState = state;
  req.session.oauthVerifier = verifier;
  req.session.save(error => {
    if (error) return next(error);
    const authorize = new URL('https://discord.com/oauth2/authorize');
    authorize.search = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();
    res.redirect(authorize.toString());
  });
});

app.get('/auth/discord/callback', async (req, res) => {
  if (discordConfigured && !discordCallbackMatchesRequest(req)) {
    return res.status(503).send('ที่อยู่ Discord Redirect URI ไม่ตรงกับเว็บไซต์นี้ กรุณาตั้ง DISCORD_REDIRECT_URI เป็น URL HTTPS ของเว็บไซต์ตามด้วย /auth/discord/callback และตั้ง URL เดียวกันใน Discord Developer Portal');
  }
  const expectedState = req.session.oauthState;
  const verifier = req.session.oauthVerifier;
  delete req.session.oauthState;
  delete req.session.oauthVerifier;
  try {
    await saveSession(req);
    if (!discordConfigured) return res.status(503).send('ยังไม่ได้ตั้งค่า Discord OAuth');
    if (req.query.error) return res.status(400).send('การเข้าสู่ระบบ Discord ถูกยกเลิกหรือไม่ได้รับอนุญาต');
    if (!oauthValueMatches(req.query.state, expectedState) || typeof verifier !== 'string' || typeof req.query.code !== 'string') {
      return res.status(400).send('คำขอเข้าสู่ระบบไม่ถูกต้องหรือหมดอายุ กรุณาลองใหม่');
    }

    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
        code_verifier: verifier
      })
    });
    if (!tokenResponse.ok) {
      const contentType = tokenResponse.headers.get('content-type') || 'unknown';
      const responseBody = await tokenResponse.text();
      let tokenError = null;
      try {
        tokenError = JSON.parse(responseBody);
      } catch {
        tokenError = null;
      }
      const errorCode = typeof tokenError?.error === 'string' && /^[a-z0-9_]{1,64}$/i.test(tokenError.error)
        ? tokenError.error
        : 'unknown_error';
      const responseType = tokenError ? 'json' : 'non-json';
      const retryAfterHeader = Number(tokenResponse.headers.get('retry-after'));
      const retryAfterBody = Number(tokenError?.retry_after);
      const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader
        : Number.isFinite(retryAfterBody) && retryAfterBody > 0
          ? retryAfterBody
          : null;
      console.error(`Discord token exchange failed with HTTP ${tokenResponse.status} (${errorCode}; response=${responseType}; content-type=${contentType.slice(0, 100)}${retryAfterSeconds ? `; retry-after=${Math.ceil(retryAfterSeconds)}s` : ''})`);

      const errorMessages = {
        invalid_client: 'Discord ไม่ยอมรับ Client ID หรือ Client Secret กรุณาตรวจว่าคัดลอกจากแอปพลิเคชันเดียวกันและใช้ Client Secret ปัจจุบันในไฟล์ .env แล้วรีสตาร์ตเซิร์ฟเวอร์',
        invalid_grant: 'รหัสเข้าสู่ระบบหมดอายุหรือถูกใช้ไปแล้ว กรุณาเริ่มเข้าสู่ระบบ Discord ใหม่ และตรวจว่า Redirect URI ใน .env ตรงกับ Discord Developer Portal ทุกตัวอักษร',
        invalid_request: 'คำขอเข้าสู่ระบบไม่ถูกต้อง กรุณาตรวจ Client ID, Redirect URI และการตั้งค่า OAuth ใน Discord Developer Portal'
      };
      if (tokenResponse.status === 429) {
        const waitMessage = retryAfterSeconds
          ? `กรุณารอประมาณ ${Math.ceil(retryAfterSeconds)} วินาที`
          : 'กรุณารอสักครู่';
        return res.status(502).send(`Discord จำกัดคำขอเข้าสู่ระบบชั่วคราว (${errorCode}) ${waitMessage} แล้วเริ่มเข้าสู่ระบบใหม่เพียงครั้งเดียว ห้ามรีเฟรช callback เดิม`);
      }
      if (errorMessages[errorCode]) return res.status(502).send(errorMessages[errorCode]);
      return res.status(502).send(`Discord ปฏิเสธคำขอแลกเปลี่ยนรหัสเข้าสู่ระบบ (HTTP ${tokenResponse.status}; ${responseType}; ${contentType.slice(0, 100)}) กรุณาตรวจ Logs ของ Render เพื่อดูรายละเอียด แล้วลองใหม่`);
    }
    const token = await tokenResponse.json();
    if (typeof token.access_token !== 'string') {
      console.error('Discord token response did not contain an access token');
      return res.status(502).send('Discord ส่งข้อมูลยืนยันตัวตนกลับมาไม่ถูกต้อง');
    }

    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!userResponse.ok) {
      console.error(`Discord user lookup failed with HTTP ${userResponse.status}`);
      return res.status(502).send('ไม่สามารถตรวจสอบบัญชี Discord ได้ กรุณาลองใหม่ภายหลัง');
    }
    const discordUser = await userResponse.json();
    if (!validDiscordId(discordUser.id) || typeof discordUser.username !== 'string') {
      console.error('Discord returned an invalid user identity');
      return res.status(502).send('Discord ส่งข้อมูลบัญชีที่ไม่ถูกต้อง');
    }

    const displayName = typeof discordUser.global_name === 'string' && discordUser.global_name
      ? discordUser.global_name
      : discordUser.username;
    db.prepare(`INSERT INTO users (provider, provider_user_id, display_name)
      VALUES ('discord', ?, ?)
      ON CONFLICT(provider, provider_user_id) DO UPDATE SET display_name = excluded.display_name`)
      .run(discordUser.id, displayName);

    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = {
      provider: 'discord',
      providerUserId: discordUser.id,
      displayName,
      avatarUrl: discordAvatarUrl(discordUser.id, discordUser.avatar)
    };
    await saveSession(req);
    res.redirect('/#vote-guide');
  } catch (error) {
    console.error('Discord OAuth callback failed:', error);
    if (!res.headersSent) res.status(500).send('เกิดข้อผิดพลาดระหว่างเข้าสู่ระบบ กรุณาลองใหม่');
  }
});

app.post('/auth/logout', requireLogin, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('rp-election.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.json({ ok: true });
  });
});

app.post('/api/vote', requireLogin, (req, res) => {
  if (!isElectionOpen()) return res.status(403).json({ error: 'ขณะนี้ยังไม่เปิดลงคะแนน' });
  const candidateId = Number(req.body.candidateId);
  if (!Number.isSafeInteger(candidateId)) return res.status(400).json({ error: 'ข้อมูลผู้สมัครไม่ถูกต้อง' });
  const candidate = db.prepare('SELECT id FROM candidates WHERE id = ? AND active = 1').get(candidateId);
  if (!candidate) return res.status(400).json({ error: 'ไม่พบผู้สมัครที่เลือก' });
  const voterId = `discord:${req.session.user.providerUserId}`;
  try {
    const castVote = db.transaction(() => {
      db.prepare('INSERT INTO votes (voter_id, election_term_id, candidate_id) VALUES (?, ?, ?)')
        .run(voterId, currentTermId, candidateId);
      audit.run('vote_cast', voterId, `term_id=${currentTermId}; candidate_id=${candidateId}`);
    });
    castVote();
    res.json({ ok: true, message: 'บันทึกคะแนนเรียบร้อยแล้ว ไม่สามารถลงคะแนนซ้ำได้' });
  } catch (err) {
    if (String(err.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) {
      audit.run('duplicate_vote_blocked', voterId, `duplicate vote attempt; term_id=${currentTermId}`);
      return res.status(409).json({ error: 'บัญชีนี้ลงคะแนนในสมัยการเลือกตั้งนี้ไปแล้ว ไม่สามารถลงคะแนนซ้ำได้' });
    }
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกคะแนน' });
  }
});

app.get('/api/admin/audit', requireLogin, requireAdmin, (_req, res) => {
  res.json(db.prepare('SELECT event, actor_id, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

app.listen(port, () => console.log(`Roblox RP Election server running at http://localhost:${port}`));
