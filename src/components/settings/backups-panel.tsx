import { SettingsCard } from "@/components/settings/settings-frame";
import { readBackupSettings } from "@/lib/backup";

// Whether automatic backups are on, and how to restore one. Backups are a
// server configuration (a separate private Blob store), never a setting a
// browser can change, so this card only reports.

export function BackupsPanel() {
  const backup = readBackupSettings();

  return (
    <SettingsCard
      description="A daily copy of the database and every stored document, kept in a separate private store."
      id="backups"
      title="Backups"
    >
      {backup ? (
        <div className="notice notice-success" role="status">
          Automatic backups are on. Each backup is kept for {backup.keepDays}{" "}
          days.
        </div>
      ) : (
        <div className="notice notice-warning" role="status">
          Automatic backups are off. A server administrator turns them on by
          setting <code className="text-xs">BACKUP_BLOB_READ_WRITE_TOKEN</code>{" "}
          to a separate private Blob store. Self-hosted installs can also back
          up PostgreSQL and the storage folder with their own tools.
        </div>
      )}
      <p className="text-sm leading-6 text-(--secondary)">
        To restore, run <code className="text-xs">npm run restore-backup</code>{" "}
        on a server with the database credentials. The signing keys and{" "}
        <code className="text-xs">BETTER_AUTH_SECRET</code> must be the same as
        when the backup was made, so keep them with your backups. See
        docs/backup-and-restore.md.
      </p>
    </SettingsCard>
  );
}
