const MIGRATIONS = [
  {
    id: '001-create-share-links',
    async up(db) {
      await db.run(`
        CREATE TABLE IF NOT EXISTS share_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shareToken TEXT UNIQUE NOT NULL,
          userId TEXT NOT NULL,
          filePath TEXT NOT NULL,
          fileName TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          expiresAt INTEGER,
          maxDownloads INTEGER DEFAULT 0,
          downloadCount INTEGER DEFAULT 0,
          password TEXT,
          isActive INTEGER DEFAULT 1,
          lastDownloadAt INTEGER
        )
      `);
    }
  },
  {
    id: '002-add-share-location-id',
    async up(db) {
      const columns = await db.all('PRAGMA table_info(share_links)');
      if (!columns.some((column) => column.name === 'locationId')) {
        await db.run("ALTER TABLE share_links ADD COLUMN locationId TEXT NOT NULL DEFAULT 'default'");
      }
    }
  },
  {
    id: '003-share-link-indexes',
    async up(db) {
      await db.run('CREATE INDEX IF NOT EXISTS idx_share_token ON share_links(shareToken)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_user_id ON share_links(userId)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_expires_active ON share_links(expiresAt, isActive)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_share_location ON share_links(locationId)');
    }
  }
];

async function runMigrations(db) {
  await db.run('PRAGMA foreign_keys = ON');
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      appliedAt INTEGER NOT NULL
    )
  `);

  for (const migration of MIGRATIONS) {
    const applied = await db.get('SELECT id FROM schema_migrations WHERE id = ?', [migration.id]);
    if (applied) continue;

    await migration.up(db);
    await db.run('INSERT INTO schema_migrations (id, appliedAt) VALUES (?, ?)', [migration.id, Date.now()]);
  }
}

module.exports = { MIGRATIONS, runMigrations };
