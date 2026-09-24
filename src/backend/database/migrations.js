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
  },
  {
    id: '004-create-user-pane-backgrounds',
    description: 'Create user-owned Pane Style background image storage.',
    async up(db) {
      await db.run(`
        CREATE TABLE IF NOT EXISTS user_pane_backgrounds (
          userId TEXT PRIMARY KEY,
          image BLOB NOT NULL,
          mimeType TEXT NOT NULL,
          name TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          size INTEGER NOT NULL,
          scale REAL NOT NULL,
          positionX REAL NOT NULL,
          positionY REAL NOT NULL,
          updatedAt INTEGER NOT NULL
        )
      `);
    }
  },
  {
    id: '005-create-ssh-terminal-storage',
    description: 'Create user-owned SSH targets and host-key audit storage.',
    async up(db) {
      await db.run(`
        CREATE TABLE IF NOT EXISTS user_ssh_targets (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          displayName TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 22,
          username TEXT NOT NULL,
          authType TEXT NOT NULL,
          encryptedPrivateKey TEXT,
          encryptedPassword TEXT,
          encryptedPassphrase TEXT,
          hostKeyType TEXT,
          hostKeyData TEXT,
          hostKeyFingerprint TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          lastConnectedAt INTEGER
        )
      `);
      await db.run('CREATE INDEX IF NOT EXISTS idx_ssh_targets_user ON user_ssh_targets(userId)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_ssh_targets_user_host ON user_ssh_targets(userId, host, port)');
      await db.run(`
        CREATE TABLE IF NOT EXISTS terminal_audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          eventType TEXT NOT NULL,
          userId TEXT NOT NULL,
          targetId TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          oldFingerprint TEXT,
          newFingerprint TEXT,
          createdAt INTEGER NOT NULL
        )
      `);
      await db.run('CREATE INDEX IF NOT EXISTS idx_terminal_audit_target ON terminal_audit_events(targetId, createdAt)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_terminal_audit_user ON terminal_audit_events(userId, createdAt)');
    }
  },
  {
    id: '006-create-resumable-upload-sessions',
    description: 'Persist owner-bound resumable API upload sessions and verified file offsets.',
    async up(db) {
      await db.run(`
        CREATE TABLE IF NOT EXISTS upload_sessions (
          sessionId TEXT PRIMARY KEY,
          ownerIdType TEXT NOT NULL CHECK(ownerIdType IN ('number', 'string')),
          ownerId TEXT NOT NULL,
          username TEXT NOT NULL,
          locationId TEXT NOT NULL,
          locationRevision TEXT NOT NULL,
          destinationPath TEXT NOT NULL,
          clientAttemptId TEXT NOT NULL,
          chunkSize INTEGER NOT NULL,
          expectedFileCount INTEGER NOT NULL,
          expectedDirectoryCount INTEGER NOT NULL,
          totalSize INTEGER NOT NULL DEFAULT 0,
          uploadedSize INTEGER NOT NULL DEFAULT 0,
          manifestComplete INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          expiresAt INTEGER NOT NULL
        )
      `);
      await db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_sessions_attempt
        ON upload_sessions(ownerIdType, ownerId, username, clientAttemptId)
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner_status
        ON upload_sessions(ownerIdType, ownerId, username, status, expiresAt)
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS upload_session_files (
          fileId TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL REFERENCES upload_sessions(sessionId) ON DELETE CASCADE,
          fileIndex INTEGER NOT NULL,
          relativePath TEXT NOT NULL,
          collisionKey TEXT NOT NULL,
          fileName TEXT NOT NULL,
          size INTEGER NOT NULL,
          chunkHashes TEXT NOT NULL,
          manifestHash TEXT NOT NULL,
          uploadedOffset INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          publishPath TEXT,
          publishTempPath TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          UNIQUE(sessionId, fileIndex)
        )
      `);
      await db.run('CREATE INDEX IF NOT EXISTS idx_upload_session_files_session ON upload_session_files(sessionId, fileIndex)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_upload_session_files_collision ON upload_session_files(sessionId, collisionKey, fileIndex, status)');
      await db.run(`
        CREATE TABLE IF NOT EXISTS upload_session_directories (
          sessionId TEXT NOT NULL REFERENCES upload_sessions(sessionId) ON DELETE CASCADE,
          directoryIndex INTEGER NOT NULL,
          relativePath TEXT NOT NULL,
          PRIMARY KEY(sessionId, directoryIndex)
        )
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS upload_session_manifest_pages (
          sessionId TEXT NOT NULL REFERENCES upload_sessions(sessionId) ON DELETE CASCADE,
          pageIndex INTEGER NOT NULL,
          fileOffset INTEGER NOT NULL,
          directoryOffset INTEGER NOT NULL,
          fileCount INTEGER NOT NULL,
          directoryCount INTEGER NOT NULL,
          contentBytes INTEGER NOT NULL,
          contentHash TEXT NOT NULL,
          PRIMARY KEY(sessionId, pageIndex)
        )
      `);
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
