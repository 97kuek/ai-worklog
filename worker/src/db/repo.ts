/** Returns the id of the user with this email, creating it if needed (race-safe). */
export async function ensureUser(db: D1Database, email: string, now: number): Promise<string> {
  const [, found] = await db.batch<{ id: string }>([
    db
      .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING")
      .bind(crypto.randomUUID(), email, now),
    db.prepare("SELECT id FROM users WHERE email = ?").bind(email),
  ]);
  return found.results[0]!.id;
}

/** Returns the id of the machine with this Access client id, creating it if needed (race-safe). */
export async function ensureMachine(
  db: D1Database,
  userId: string,
  accessClientId: string,
  now: number,
): Promise<string> {
  const [, found] = await db.batch<{ id: string }>([
    db
      .prepare(
        "INSERT INTO machines (id, user_id, access_client_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(access_client_id) DO NOTHING",
      )
      .bind(crypto.randomUUID(), userId, accessClientId, now),
    db.prepare("SELECT id FROM machines WHERE access_client_id = ?").bind(accessClientId),
  ]);
  return found.results[0]!.id;
}
