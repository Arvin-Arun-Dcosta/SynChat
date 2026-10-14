import { Db, migrate } from "../src/db.js";

/** Rebuild the test database's schema from the migrations before the suite runs. */
export default async function setup() {
  const url = process.env.DATABASE_URL ?? "postgres://synchat:synchat@127.0.0.1:5433/synchat_test";
  if (!/_test(\?|$)/.test(url)) {
    throw new Error(`Refusing to run tests against a database not named *_test: ${url}`);
  }
  const db = new Db(url);
  try {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
  } finally {
    await db.close();
  }
}
