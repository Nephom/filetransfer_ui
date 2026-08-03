const MIGRATIONS = [
  {
    id: '001-create-share-links',
    description: 'Create the share_links table used for public file-share metadata.',
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
    description: 'Add Location scope to existing share links; legacy rows use the default Location.',
    async up(db) {
      const columns = await db.all('PRAGMA table_info(share_links)');
      if (!columns.some((column) => column.name === 'locationId')) {
        await db.run("ALTER TABLE share_links ADD COLUMN locationId TEXT NOT NULL DEFAULT 'default'");
      }
    }
  },
  {
    id: '003-share-link-indexes',
    description: 'Add lookup indexes for share tokens, users, expiry state, and Location scope.',
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
      description TEXT NOT NULL DEFAULT '',
      appliedAt INTEGER NOT NULL
    )
  `);

  const migrationColumns = await db.all('PRAGMA table_info(schema_migrations)');
  if (!migrationColumns.some((column) => column.name === 'description')) {
    await db.run("ALTER TABLE schema_migrations ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }

  for (const migration of MIGRATIONS) {
    const applied = await db.get('SELECT id FROM schema_migrations WHERE id = ?', [migration.id]);
    if (applied) {
      await db.run(
        "UPDATE schema_migrations SET description = ? WHERE id = ? AND (description IS NULL OR description = '')",
        [migration.description, migration.id]
      );
      continue;
    }

    await migration.up(db);
    await db.run(
      'INSERT INTO schema_migrations (id, description, appliedAt) VALUES (?, ?, ?)',
      [migration.id, migration.description, Date.now()]
    );
  }
}

module.exports = { MIGRATIONS, runMigrations };
